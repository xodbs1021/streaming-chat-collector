import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { computeReconnectDelayMs } from "./providers/reconnectBackoff";

const CHZZK_USER_AGENT = "Mozilla/5.0 chzzk-multichat-overlay";
const FRAME_HEIGHT = 720;
const FRAME_FPS = 1;
const FRAME_JPEG_QUALITY = 5;
const INDEX_REFRESH_MS = 5_000;
const RETENTION_MS = 48 * 3_600_000;
const RETENTION_SWEEP_MS = 3_600_000;
const NEAREST_TOLERANCE_SEC = 15;
const STALL_THRESHOLD_MS = 15_000;
const KILL_GRACE_MS = 2_000;

export type FrameCaptureLogLevel = "info" | "warning" | "error";

export interface FrameCaptureLogger {
  (level: FrameCaptureLogLevel, message: string): void;
}

/** livePlaybackJson 문자열에서 HLS 스트림 주소를 뽑는다 */
export function extractHlsUrl(livePlaybackJson: string): string | undefined {
  try {
    const parsed = JSON.parse(livePlaybackJson) as { media?: Array<{ mediaId?: string; protocol?: string; path?: string }> };
    const medias = Array.isArray(parsed?.media) ? parsed.media : [];
    const hls = medias.find((media) => media?.mediaId === "HLS" || media?.protocol === "HLS");
    return typeof hls?.path === "string" && hls.path ? hls.path : undefined;
  } catch {
    return undefined;
  }
}

/** 정렬된 epochSec 배열에서 target 이하의 최근접 값을 찾는다 (허용 오차 초과 시 undefined) */
export function nearestFrameSecond(sortedSeconds: number[], target: number, toleranceSec = NEAREST_TOLERANCE_SEC): number | undefined {
  let low = 0;
  let high = sortedSeconds.length - 1;
  let best: number | undefined;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (sortedSeconds[mid] <= target) {
      best = sortedSeconds[mid];
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  if (best === undefined || target - best > toleranceSec) {
    return undefined;
  }
  return best;
}

async function fetchChzzkHlsUrl(channelId: string): Promise<string | undefined> {
  const response = await fetch(
    `https://api.chzzk.naver.com/service/v3/channels/${encodeURIComponent(channelId)}/live-detail`,
    {
      headers: {
        Accept: "application/json",
        Origin: "https://chzzk.naver.com",
        Referer: `https://chzzk.naver.com/live/${encodeURIComponent(channelId)}`,
        "User-Agent": CHZZK_USER_AGENT
      }
    }
  );
  if (!response.ok) {
    return undefined;
  }
  const json = (await response.json()) as { content?: { livePlaybackJson?: string } };
  const playback = json.content?.livePlaybackJson;
  return typeof playback === "string" ? extractHlsUrl(playback) : undefined;
}

export class FrameCaptureManager {
  private child: ChildProcess | undefined;
  private stopped = true;
  private channelId = "";
  private restartTimer: ReturnType<typeof setTimeout> | undefined;
  private restartAttempts = 0;
  private indexTimer: ReturnType<typeof setInterval> | undefined;
  private sweepTimer: ReturnType<typeof setInterval> | undefined;
  private frameSeconds: number[] = [];
  private ffmpegMissingLogged = false;
  private hlsWarningLogged = false;
  private lastError: string | undefined;
  private lastFrameGrowthAt = Date.now();

  constructor(
    private readonly framesDir: string,
    private readonly log: FrameCaptureLogger
  ) {}

  isEnabled() {
    return process.env.FRAME_CAPTURE !== "0";
  }

  async start(channelId: string) {
    if (!this.isEnabled() || !channelId) {
      return;
    }
    this.stopped = false;
    this.channelId = channelId;
    this.restartAttempts = 0;
    this.lastFrameGrowthAt = Date.now();
    this.hlsWarningLogged = false;
    await mkdir(this.framesDir, { recursive: true });
    this.startIndexPolling();
    this.startRetentionSweep();
    await this.spawnCapture();
  }

  async stop() {
    this.stopped = true;
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = undefined;
    }
    if (this.indexTimer) {
      clearInterval(this.indexTimer);
      this.indexTimer = undefined;
    }
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = undefined;
    }
    if (this.child) {
      const child = this.child;
      this.child = undefined;
      // 실제로 종료될 때까지 기다려야 한다 — 서버 프로세스 자체가 곧바로 exit()하면
      // SIGKILL 유예 타이머가 이벤트루프와 함께 사라져 좀비 ffmpeg가 남을 수 있다.
      await this.killChild(child);
    }
  }

  /** SIGTERM 후 유예시간 안에 종료 안 되면 SIGKILL로 확실히 정리한다 (실측: 멈춘 ffmpeg가 SIGTERM을 무시하는 경우 있음) */
  private killChild(child: ChildProcess): Promise<void> {
    return new Promise((resolve) => {
      let settled = false;
      child.once("exit", () => {
        settled = true;
        resolve();
      });
      child.kill("SIGTERM");
      setTimeout(() => {
        if (!settled) {
          child.kill("SIGKILL");
        }
      }, KILL_GRACE_MS);
    });
  }

  nearestFrame(second: number) {
    return nearestFrameSecond(this.frameSeconds, second);
  }

  listFrameSeconds(from: number, to: number) {
    return this.frameSeconds.filter((second) => second >= from && second <= to);
  }

  framePath(second: number) {
    return path.join(this.framesDir, `${second}.jpg`);
  }

  getDebugState() {
    return {
      enabled: this.isEnabled(),
      stopped: this.stopped,
      channelId: this.channelId,
      capturing: Boolean(this.child),
      restartAttempts: this.restartAttempts,
      restartScheduled: Boolean(this.restartTimer),
      frameCount: this.frameSeconds.length,
      lastError: this.lastError
    };
  }

  private async spawnCapture() {
    if (this.stopped) {
      return;
    }
    let hlsUrl: string | undefined;
    try {
      hlsUrl = await fetchChzzkHlsUrl(this.channelId);
      if (!hlsUrl) {
        this.lastError = "live-detail 응답에 HLS 주소 없음 (오프라인/DRM/준비중)";
      }
    } catch (error) {
      this.lastError = `스트림 정보 조회 실패: ${error instanceof Error ? error.message : "unknown"}`;
      this.log("warning", `프레임 캡처: ${this.lastError}`);
    }
    if (!hlsUrl) {
      // DRM 채널이거나 방송 오프라인 — 백오프로 재시도하되 로그는 최초 1회만 (스팸 방지)
      if (!this.hlsWarningLogged) {
        this.hlsWarningLogged = true;
        this.log("warning", "프레임 캡처: HLS 주소를 얻지 못했습니다 (DRM/오프라인 가능). 방송이 시작되면 자동으로 캡처합니다.");
      }
      this.scheduleRestart();
      return;
    }
    this.hlsWarningLogged = false;
    this.lastError = undefined;

    // 세그먼트가 신호서명 URL만으로 인증되고 2초 단위로 빠르게 회전한다(실측 확인).
    // 커스텀 헤더는 불필요해서 뺐고, 대신 HTTP 재연결 옵션으로 짧은 세그먼트 만료 경합에 대비한다.
    const child = spawn(
      "ffmpeg",
      [
        "-hide_banner",
        "-loglevel",
        "warning",
        // 이 CDN의 fMP4 세그먼트가 .m4v 확장자를 쓰는데, ffmpeg hls 디먹서의 기본
        // 엄격 확장자 검사(extension_picky)가 이를 거부해 "Invalid data found"로
        // 실패했다 (실측 확인: extension_picky 끄면 정상 캡처됨).
        "-extension_picky",
        "0",
        "-reconnect",
        "1",
        "-reconnect_streamed",
        "1",
        "-reconnect_at_eof",
        "1",
        "-reconnect_delay_max",
        "5",
        "-i",
        hlsUrl,
        "-vf",
        `fps=${FRAME_FPS},scale=-2:${FRAME_HEIGHT}`,
        "-q:v",
        String(FRAME_JPEG_QUALITY),
        "-f",
        "image2",
        "-strftime",
        "1",
        path.join(this.framesDir, "%s.jpg")
      ],
      { stdio: ["ignore", "pipe", "pipe"] }
    );
    this.child = child;
    this.lastFrameGrowthAt = Date.now();

    let stderrTail = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      stderrTail = `${stderrTail}${chunk.toString("utf8")}`.slice(-2000);
    });

    child.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") {
        if (!this.ffmpegMissingLogged) {
          this.ffmpegMissingLogged = true;
          this.log("warning", "프레임 캡처: ffmpeg가 설치되어 있지 않아 비활성화됩니다 (brew install ffmpeg).");
        }
        this.stopped = true;
        return;
      }
      this.log("error", `프레임 캡처 프로세스 오류: ${error.message}`);
    });

    child.on("exit", (code) => {
      if (this.child === child) {
        this.child = undefined;
      }
      if (!this.stopped) {
        const detail = stderrTail.trim().split("\n").slice(-3).join(" / ");
        this.lastError = `ffmpeg 종료 (code ${code ?? "?"})${detail ? `: ${detail}` : ""}`;
        this.log("warning", `프레임 캡처가 중단되었습니다. ${this.lastError}`);
        this.scheduleRestart();
      }
    });

    this.log("info", `프레임 캡처 시작 (${this.channelId}, ${FRAME_FPS}fps/${FRAME_HEIGHT}p)`);
  }

  private scheduleRestart() {
    if (this.stopped || this.restartTimer) {
      return;
    }
    this.restartAttempts += 1;
    const delay = computeReconnectDelayMs(this.restartAttempts);
    this.restartTimer = setTimeout(() => {
      this.restartTimer = undefined;
      void this.spawnCapture();
    }, delay);
  }

  private startIndexPolling() {
    if (this.indexTimer) {
      return;
    }
    const refresh = () => {
      void this.refreshIndex();
    };
    refresh();
    this.indexTimer = setInterval(refresh, INDEX_REFRESH_MS);
    (this.indexTimer as { unref?: () => void }).unref?.();
  }

  private async refreshIndex() {
    try {
      const entries = await readdir(this.framesDir);
      const seconds = entries
        .filter((entry) => entry.endsWith(".jpg"))
        .map((entry) => Number(entry.replace(/\.jpg$/, "")))
        .filter((second) => Number.isFinite(second))
        .sort((left, right) => left - right);
      if (seconds.length > this.frameSeconds.length) {
        // 새 프레임이 쌓이고 있으면 캡처가 살아있다는 뜻 — 백오프 리셋 + 정체 감시 타이머 리셋
        this.restartAttempts = 0;
        this.lastFrameGrowthAt = Date.now();
      }
      this.frameSeconds = seconds;
    } catch {
      this.frameSeconds = [];
    }

    // ffmpeg 프로세스가 죽지 않은 채(exit 이벤트 없이) 조용히 멈춰서 새 프레임을
    // 안 만드는 경우 — exit 기반 재시작 로직으로는 못 잡으므로 별도로 감시한다.
    if (this.child && !this.stopped && Date.now() - this.lastFrameGrowthAt > STALL_THRESHOLD_MS) {
      this.log("warning", `프레임 캡처가 ${Math.round(STALL_THRESHOLD_MS / 1000)}초 넘게 정체되어 강제로 재시작합니다.`);
      this.lastFrameGrowthAt = Date.now();
      this.child.kill("SIGKILL");
    }
  }

  private startRetentionSweep() {
    if (this.sweepTimer) {
      return;
    }
    const sweep = () => {
      void this.sweepOldFrames();
    };
    sweep();
    this.sweepTimer = setInterval(sweep, RETENTION_SWEEP_MS);
    (this.sweepTimer as { unref?: () => void }).unref?.();
  }

  private async sweepOldFrames() {
    const cutoffSec = Math.floor((Date.now() - RETENTION_MS) / 1000);
    const stale = this.frameSeconds.filter((second) => second < cutoffSec);
    for (const second of stale) {
      await rm(this.framePath(second), { force: true }).catch(() => undefined);
    }
    if (stale.length > 0) {
      this.frameSeconds = this.frameSeconds.filter((second) => second >= cutoffSec);
    }
  }
}
