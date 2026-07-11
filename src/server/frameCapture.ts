import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { computeReconnectDelayMs } from "./providers/reconnectBackoff";
import { nearestFrameSecond } from "../shared/frameSeconds";
import { computeCaptureStatus, type FrameCaptureFailureReason, type FrameCaptureStatus } from "../shared/frameCaptureStatus";

const CHZZK_USER_AGENT = "Mozilla/5.0 chzzk-multichat-overlay";
const FRAME_HEIGHT = 720;
const FRAME_FPS = 1;
const FRAME_JPEG_QUALITY = 5;
const INDEX_REFRESH_MS = 5_000;
const RETENTION_MS = 48 * 3_600_000;
const RETENTION_SWEEP_MS = 3_600_000;
const STALL_THRESHOLD_MS = 15_000;
const KILL_GRACE_MS = 2_000;

export type FrameCaptureLogLevel = "info" | "warning" | "error";

export interface FrameCaptureLogger {
  (level: FrameCaptureLogLevel, message: string): void;
}

export { nearestFrameSecond };

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

export async function fetchChzzkHlsUrl(channelId: string): Promise<string | undefined> {
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

const SOOP_LIVE_API_URL = "https://live.sooplive.co.kr/afreeca/player_live_api.php";
const SOOP_PLAY_ORIGIN = "https://play.sooplive.co.kr";
const SOOP_USER_AGENT = "Mozilla/5.0 soop-multichat-overlay";
const HLS_URL_PATTERN = /^https?:\/\/\S+\.m3u8(\?\S*)?$/i;

/**
 * JSON 트리 어디에 있든 .m3u8로 끝나는 URL 문자열을 재귀 탐색한다.
 * SOOP(구 아프리카TV)의 player_live_api.php 응답은 필드명이 공개 문서화되어 있지 않아,
 * 특정 키 이름에 의존하는 대신 응답 전체에서 HLS URL을 찾는 방식을 택했다.
 * 실제 라이브 응답으로 검증되지 않았으므로, 캡처가 계속 안 잡히면 방송 중 브라우저
 * 네트워크 탭에서 실제 요청/응답을 캡처해 이 함수를 교체해야 한다.
 */
export function findHlsUrlDeep(value: unknown, depth = 0): string | undefined {
  if (depth > 6) {
    return undefined;
  }
  if (typeof value === "string") {
    return HLS_URL_PATTERN.test(value) ? value : undefined;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findHlsUrlDeep(item, depth + 1);
      if (found) {
        return found;
      }
    }
    return undefined;
  }
  if (value && typeof value === "object") {
    for (const key of Object.keys(value as Record<string, unknown>)) {
      const found = findHlsUrlDeep((value as Record<string, unknown>)[key], depth + 1);
      if (found) {
        return found;
      }
    }
  }
  return undefined;
}

/** SOOP 라이브 재생 정보를 조회해 HLS 주소를 찾는다 (필드명 미검증 — findHlsUrlDeep 주석 참고) */
export async function fetchSoopHlsUrl(bjId: string): Promise<string | undefined> {
  const body = new URLSearchParams({
    bid: bjId,
    type: "live",
    pwd: "",
    player_type: "html5",
    stream_type: "common",
    quality: "HD",
    mode: "landing",
    from_api: "0"
  });
  const response = await fetch(SOOP_LIVE_API_URL, {
    method: "POST",
    headers: {
      Accept: "application/json, text/plain, */*",
      "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
      Origin: SOOP_PLAY_ORIGIN,
      Referer: `${SOOP_PLAY_ORIGIN}/${encodeURIComponent(bjId)}`,
      "User-Agent": SOOP_USER_AGENT
    },
    body
  });
  if (!response.ok) {
    return undefined;
  }
  const json: unknown = await response.json();
  return findHlsUrlDeep(json);
}

export type HlsUrlResolver = (channelId: string) => Promise<string | undefined>;

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
  private ffmpegMissing = false;
  private hlsWarningLogged = false;
  private lastError: string | undefined;
  private lastFailureReason: FrameCaptureFailureReason | undefined;
  private lastFrameGrowthAt = Date.now();

  constructor(
    private readonly framesDir: string,
    private readonly resolveHlsUrl: HlsUrlResolver,
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
    // 재연결 시 재판정 — ffmpeg를 나중에 설치한 경우 서버 재시작 없이도 캡처 가능 상태로 복귀
    this.ffmpegMissing = false;
    this.lastFrameGrowthAt = Date.now();
    this.hlsWarningLogged = false;
    await mkdir(this.framesDir, { recursive: true });
    this.startIndexPolling();
    this.startRetentionSweep();
    await this.spawnCapture();
  }

  async stop() {
    this.stopped = true;
    // 해제 후 잔류 사유/카운터가 거짓 상태를 표시하지 않도록 클리어 (start()에서만 리셋되던 것을 보완)
    this.lastFailureReason = undefined;
    this.restartAttempts = 0;
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

  /** 내부 필드로 스냅샷을 조립해 순수 매핑 함수에 위임한다 (판정 로직·문구는 shared 단일 진실원) */
  getCaptureStatus(): FrameCaptureStatus {
    return computeCaptureStatus({
      enabled: this.isEnabled(),
      stopped: this.stopped,
      capturing: Boolean(this.child),
      restartScheduled: Boolean(this.restartTimer),
      restartAttempts: this.restartAttempts,
      frameCount: this.frameSeconds.length,
      ffmpegMissing: this.ffmpegMissing,
      lastFailureReason: this.lastFailureReason
    });
  }

  private async spawnCapture() {
    if (this.stopped) {
      return;
    }
    let hlsUrl: string | undefined;
    try {
      hlsUrl = await this.resolveHlsUrl(this.channelId);
      if (!hlsUrl) {
        this.lastError = "live-detail 응답에 HLS 주소 없음 (오프라인/DRM/준비중)";
      }
    } catch (error) {
      this.lastError = `스트림 정보 조회 실패: ${error instanceof Error ? error.message : "unknown"}`;
      this.log("warning", `프레임 캡처: ${this.lastError}`);
    }
    if (!hlsUrl) {
      // DRM 채널이거나 방송 오프라인 — 백오프로 재시도하되 로그는 최초 1회만 (스팸 방지)
      this.lastFailureReason = "no-hls";
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
        this.ffmpegMissing = true;
        if (!this.ffmpegMissingLogged) {
          this.ffmpegMissingLogged = true;
          this.log("warning", "프레임 캡처: ffmpeg가 설치되어 있지 않아 비활성화됩니다 (brew install ffmpeg).");
        }
        this.stopped = true;
        return;
      }
      this.lastFailureReason = "spawn-error";
      this.log("error", `프레임 캡처 프로세스 오류: ${error.message}`);
    });

    child.on("exit", (code) => {
      if (this.child === child) {
        this.child = undefined;
      }
      if (!this.stopped) {
        this.lastFailureReason = "ffmpeg-exit";
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
        // 새 프레임이 쌓이고 있으면 캡처가 살아있다는 뜻 — 백오프 리셋 + 정체 감시 타이머 리셋 + 사유 클리어
        this.restartAttempts = 0;
        this.lastFailureReason = undefined;
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
