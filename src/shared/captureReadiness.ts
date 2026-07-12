import type { FrameCaptureSnapshot } from "./frameCaptureStatus";

/**
 * 연결 시퀀스 동기화용 기동 판정 — "캡처가 채팅과 함께 시작할 준비가 되었나"를
 * 폴 루프가 매 tick 물어보는 단일 진실원. frameCaptureStatus(5초 폴링 steady-state)와
 * 달리 이건 연결 순간의 트랜지언트 판정이라 별도 축으로 둔다.
 */
export type CaptureReadiness =
  | "ready" // HLS 확보 + child spawn 관측 — 채팅과 동시 시작
  | "no-hls" // 오프라인/DRM — 채팅만, 방송 시작 시 백오프가 자동 부착
  | "stream-error" // spawn 실패/ffmpeg 조기 종료 — 채팅만 + 백그라운드 재시도
  | "ffmpeg-missing" // ffmpeg 미설치 — 대기 없이 채팅만
  | "timeout" // 제한시간 내 기동 관측 실패 — 채팅만
  | "disabled" // 캡처 비활성/미적용 — 대기 없이 채팅만
  | "cancelled"; // 대기 중 재연결/해제 — 채팅 연결 자체를 스킵

/** waitUntilReady 폴 루프 상수 */
export const CAPTURE_READY_TIMEOUT_MS = 15_000;
export const CAPTURE_READY_POLL_MS = 100;

/**
 * 스냅샷을 기동 판정으로 정규화한다. 분기 순서가 의미를 가지므로 아래 순서를 보존해야 한다.
 * - ffmpegMissing을 최우선으로 봐서 미설치 환경은 대기 없이 즉시 이탈한다.
 * - stopped(=재연결/해제)는 capturing보다 먼저 봐야 "취소된 시퀀스의 살아있는 child"를 ready로 오인하지 않는다.
 * - spawn-error/ffmpeg-exit는 timeout까지 기다리지 않고 조기에 stream-error로 판정한다.
 *   (현행 대비 채팅 15초 지연 회귀 방지 — 캡처는 기존 백오프가 백그라운드로 재시도한다) [R2]
 */
export function classifyReadiness(
  snapshot: FrameCaptureSnapshot,
  elapsedMs: number,
  timeoutMs: number
): CaptureReadiness | "pending" {
  if (snapshot.ffmpegMissing) {
    return "ffmpeg-missing";
  }
  if (snapshot.stopped) {
    return "cancelled";
  }
  if (snapshot.capturing) {
    return "ready";
  }
  if (snapshot.lastFailureReason === "no-hls") {
    return "no-hls";
  }
  if (snapshot.lastFailureReason === "spawn-error" || snapshot.lastFailureReason === "ffmpeg-exit") {
    return "stream-error";
  }
  if (elapsedMs >= timeoutMs) {
    return "timeout";
  }
  return "pending";
}

export interface CapturePlan {
  startChat: boolean;
  warning?: string;
}

/** 각 기동 판정의 후속 플랜(채팅 시작 여부 + 사용자 경고) — 문구는 이 파일이 단일 진실원 */
export function planFromReadiness(readiness: CaptureReadiness): CapturePlan {
  switch (readiness) {
    case "ready":
    case "disabled":
      return { startChat: true };
    case "no-hls":
      return { startChat: true, warning: "이미지 불가 — 채팅만 수집 중" };
    case "stream-error":
      return { startChat: true, warning: "이미지 연결 불안정 — 채팅만 수집 중 (자동 재시도)" };
    case "ffmpeg-missing":
      return { startChat: true, warning: "ffmpeg 미설치 — 채팅만 수집 중" };
    case "timeout":
      return { startChat: true, warning: "이미지 준비 지연 — 채팅만 수집 중 (방송 시작 시 자동 연결)" };
    case "cancelled":
      return { startChat: false };
  }
}
