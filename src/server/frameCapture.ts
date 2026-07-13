import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { computeReconnectDelayMs } from "./providers/reconnectBackoff";
import { JpegStreamParser } from "./frameJpegStream";
import { FrameSecondAssigner } from "./frameSecondAssigner";
import { nearestFrameSecond } from "../shared/frameSeconds";
import { computeCaptureStatus, type FrameCaptureFailureReason, type FrameCaptureStatus, type FrameCaptureSnapshot } from "../shared/frameCaptureStatus";
import { classifyReadiness, CAPTURE_READY_POLL_MS, type CaptureReadiness } from "../shared/captureReadiness";

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

export interface FfmpegArgsParams {
  hlsUrl: string;
  fps: number;
  height: number;
  jpegQuality: number;
}

/**
 * ffmpeg 캡처 인자를 조립한다 (순수 함수 — spawn 부수효과 없음).
 * MJPEG 프레임을 파일이 아니라 stdout(`pipe:1`)으로 흘려보내, 명명 주체를
 * ffmpeg(-strftime)에서 Node로 옮긴다. Node가 파이프 순서대로 각 프레임에 진짜 초를
 * 부여하므로 벽시계-초 파일명 충돌(버스트 덮어쓰기)이 물리적으로 불가능해진다.
 * `-re`는 입력을 native rate로 페이싱해 프레임 유입을 realtime에 맞춘다. 파일명 스킴(`<초>.jpg`)은 불변.
 */
export function buildFfmpegArgs(params: FfmpegArgsParams): string[] {
  return [
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
    // 입력을 native rate(라이브=realtime)로 읽어 파이프라인을 페이싱한다.
    // 입력 옵션이므로 반드시 -i 앞에 와야 한다.
    "-re",
    "-i",
    params.hlsUrl,
    "-vf",
    `fps=${params.fps},scale=-2:${params.height}`,
    "-q:v",
    String(params.jpegQuality),
    "-f",
    "image2pipe",
    "-c:v",
    "mjpeg",
    "pipe:1"
  ];
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
  // 설정 변경(화질) 등으로 의도적으로 child를 죽였음을 표시한다. exit 핸들러가 이를 보고
  // 실패로 오인(경고 로그·백오프)하지 않고 즉시 새 높이로 재기동한다.
  private intentionalRestart = false;
  private lastError: string | undefined;
  private lastFailureReason: FrameCaptureFailureReason | undefined;
  private lastFrameGrowthAt = Date.now();
  // 프레임 명명·갭필 정책기. lastFrameSec/lastFrameBuffer를 spawn 경계 너머로 유지해
  // 재접속 짧은 공백을 메우므로 매니저 수명 내내 단일 인스턴스를 재사용한다.
  private readonly assigner = new FrameSecondAssigner();

  constructor(
    private readonly framesDir: string,
    private readonly resolveHlsUrl: HlsUrlResolver,
    private readonly log: FrameCaptureLogger,
    // 부팅 프로브 결과 주입 — "known missing"이면 spawn 없이 즉시 프라이밍한다.
    // 콜백은 "미설치로 확정되지 않았나"(unknown/ready→true)를 반환하므로, false는 확정 미설치만을 뜻한다.
    private readonly isFfmpegReady?: () => boolean,
    // 캡처 화질(세로 픽셀)을 매 spawn마다 조회한다. 설정(단일 진실원)을 읽으므로
    // 화질을 바꾸고 재기동하면 별도 상태 복제 없이 새 높이가 반영된다. 미주입 시 기본 높이.
    private readonly getFrameHeight?: () => number
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
    // 부팅 프로브가 미설치로 확정한 경우 spawn을 시도하지 않고 즉시 판정 (unknown은 런타임 ENOENT 폴백 유지)
    if (this.isFfmpegReady && !this.isFfmpegReady()) {
      this.ffmpegMissing = true;
    }
    await mkdir(this.framesDir, { recursive: true });
    this.startIndexPolling();
    this.startRetentionSweep();
    await this.spawnCapture();
  }

  /**
   * 캡처 기동이 채팅과 동시 시작할 준비가 되었는지 100ms 간격으로 폴한다.
   * 매 tick 취소 콜백을 우선 확인해(연타 재연결 시 스테일 시퀀스가 새 child를 ready로 오인하는 것 방지),
   * 그다음 순수 판정에 위임한다. pending이 아니면 즉시 반환하므로 정상 방송은 첫 tick에 해소된다.
   */
  async waitUntilReady(timeoutMs: number, isCancelled?: () => boolean): Promise<CaptureReadiness> {
    const startedAt = Date.now();
    for (;;) {
      if (isCancelled?.()) {
        return "cancelled";
      }
      const verdict = classifyReadiness(this.buildSnapshot(), Date.now() - startedAt, timeoutMs);
      if (verdict !== "pending") {
        return verdict;
      }
      await new Promise((resolve) => setTimeout(resolve, CAPTURE_READY_POLL_MS));
    }
  }

  async stop() {
    this.stopped = true;
    // 해제 후 잔류 사유/카운터가 거짓 상태를 표시하지 않도록 클리어 (start()에서만 리셋되던 것을 보완)
    this.lastFailureReason = undefined;
    this.restartAttempts = 0;
    // 화질 변경 SIGKILL 직후 exit 이벤트 전에 해제되면 이 플래그가 true로 남아,
    // 다음 세션의 실제 크래시를 의도적 재기동으로 오판(진단 유실)할 수 있어 함께 클리어한다.
    this.intentionalRestart = false;
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

  /**
   * 설정(화질) 변경을 실행 중인 캡처에 즉시 반영한다. 현재 캡처 중일 때만 child를 죽이고,
   * exit 핸들러가 intentionalRestart를 보고 백오프·경고 없이 새 높이로 곧바로 재기동한다.
   * 미연결/비활성 매니저에는 아무 일도 하지 않는다(no-op).
   */
  restartForConfigChange() {
    if (this.stopped || !this.child) {
      return;
    }
    this.intentionalRestart = true;
    this.child.kill("SIGKILL");
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

  /**
   * 완성 프레임 한 장을 진짜 초로 명명해 디스크에 쓴다. 갭필 초는 직전 프레임을 복제한다.
   * 인메모리 즉시 배정(동기) + 디스크 쓰기(비동기, 실패해도 캡처 지속)로 분리한다.
   */
  private ingestFrame(frame: Buffer) {
    const nowSec = Math.floor(Date.now() / 1000);
    // assign이 lastFrameBuffer를 갱신하기 전에 갭필 복제 소스(직전 실 프레임)를 잡아둔다.
    const fillSource = this.assigner.getLastFrameBuffer();
    const { second, fills } = this.assigner.assign(nowSec, frame);
    this.writeFrameFile(second, frame);
    if (fillSource) {
      for (const fillSecond of fills) {
        this.writeFrameFile(fillSecond, fillSource);
      }
    }
  }

  /** 프레임 바이트를 `<초>.jpg`로 비동기 저장한다. 실패는 로그만 남기고 삼키지 않는다(캡처 크래시 금지). */
  private writeFrameFile(second: number, data: Buffer) {
    void writeFile(this.framePath(second), data).catch((error: unknown) => {
      this.log("warning", `프레임 저장 실패 (${second}.jpg): ${error instanceof Error ? error.message : "unknown"}`);
    });
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

  /** 내부 필드로 순수 판정 함수들이 소비할 스냅샷을 조립한다 (getCaptureStatus·waitUntilReady 공유) */
  private buildSnapshot(): FrameCaptureSnapshot {
    return {
      enabled: this.isEnabled(),
      stopped: this.stopped,
      capturing: Boolean(this.child),
      restartScheduled: Boolean(this.restartTimer),
      restartAttempts: this.restartAttempts,
      frameCount: this.frameSeconds.length,
      ffmpegMissing: this.ffmpegMissing,
      lastFailureReason: this.lastFailureReason
    };
  }

  /** 스냅샷을 순수 매핑 함수에 위임한다 (판정 로직·문구는 shared 단일 진실원) */
  getCaptureStatus(): FrameCaptureStatus {
    return computeCaptureStatus(this.buildSnapshot());
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

    // 화질은 설정에서 매 기동마다 조회한다 — 재기동만으로 새 높이가 반영된다.
    const height = this.getFrameHeight?.() ?? FRAME_HEIGHT;

    // 세그먼트가 신호서명 URL만으로 인증되고 2초 단위로 빠르게 회전한다(실측 확인).
    // 커스텀 헤더는 불필요해서 뺐고, 대신 HTTP 재연결 옵션으로 짧은 세그먼트 만료 경합에 대비한다.
    const child = spawn(
      "ffmpeg",
      buildFfmpegArgs({
        hlsUrl,
        fps: FRAME_FPS,
        height,
        jpegQuality: FRAME_JPEG_QUALITY
      }),
      { stdio: ["ignore", "pipe", "pipe"] }
    );
    this.child = child;
    this.lastFrameGrowthAt = Date.now();

    // ffmpeg가 파이프로 흘리는 MJPEG 바이트를 프레임 경계로 재조립해, 도착 순서대로
    // 진짜 초를 부여하고 디스크에 쓴다. 파서는 spawn마다 새로 만들어 죽은 프로세스의
    // 미완성 잔여가 새 프로세스로 넘어가지 않게 한다.
    const parser = new JpegStreamParser();
    child.stdout?.on("data", (chunk: Buffer) => {
      for (const frame of parser.push(chunk)) {
        this.ingestFrame(frame);
      }
    });

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
      // spawn 경계 리셋 — 다음 프로세스의 첫 프레임이 새 기준점을 잡되, lastFrameSec/
      // lastFrameBuffer는 재접속 갭필용으로 유지된다.
      this.assigner.resetSpawn();
      if (this.stopped) {
        return;
      }
      // 화질 변경 등 의도적 재기동: 실패로 취급하지 않고 백오프 없이 즉시 새 높이로 재기동한다.
      if (this.intentionalRestart) {
        this.intentionalRestart = false;
        void this.spawnCapture();
        return;
      }
      this.lastFailureReason = "ffmpeg-exit";
      const detail = stderrTail.trim().split("\n").slice(-3).join(" / ");
      this.lastError = `ffmpeg 종료 (code ${code ?? "?"})${detail ? `: ${detail}` : ""}`;
      this.log("warning", `프레임 캡처가 중단되었습니다. ${this.lastError}`);
      this.scheduleRestart();
    });

    this.log("info", `프레임 캡처 시작 (${this.channelId}, ${FRAME_FPS}fps/${height}p)`);
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
