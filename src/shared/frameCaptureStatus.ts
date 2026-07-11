/** ffmpeg 캡처 재시작을 유발한 구조화 사유 코드 (산문 파싱 없이 코드로만 분기) */
export type FrameCaptureFailureReason = "no-hls" | "spawn-error" | "ffmpeg-exit";

export type FrameCaptureUiState =
  | "capturing" // 이미지 수집 중
  | "retrying" // 연결 재시도 중
  | "unsupported" // 미지원(DRM/오프라인) — 방송 시작 시 자동 캡처
  | "unavailable" // ffmpeg 미설치 등 환경 문제로 캡처 불가
  | "idle"; // 미연결/비활성 (UI 숨김)

/** getCaptureStatus()가 매니저 내부 필드로 손수 조립하는 평범한 스냅샷 (매니저 의존 없음 → 테스트에서 주입 가능) */
export interface FrameCaptureSnapshot {
  enabled: boolean;
  stopped: boolean;
  capturing: boolean;
  restartScheduled: boolean;
  restartAttempts: number;
  frameCount: number;
  ffmpegMissing: boolean;
  lastFailureReason?: FrameCaptureFailureReason;
}

export interface FrameCaptureStatus {
  state: FrameCaptureUiState;
  message: string; // 표시용 한국어 문구 (판정과 분리)
  frameCount: number;
}

/** 각 UI 상태의 표시 문구 — 판정(state)과 분리해 단일 진실원으로 둔다 */
const STATE_MESSAGE: Record<FrameCaptureUiState, string> = {
  capturing: "이미지 수집 중",
  retrying: "연결 재시도 중",
  unsupported: "미지원 — 방송 시작 시 자동 캡처",
  unavailable: "ffmpeg 미설치로 캡처 불가",
  idle: "캡처 대기 중"
};

/**
 * 스냅샷을 사용자용 UI 상태로 정규화한다. 분기 순서가 의미를 가지므로 아래 순서를 보존해야 한다.
 * 특히 no-hls(규칙 5)는 spawn-error/ffmpeg-exit(규칙 6)보다 반드시 먼저 판정해야 한다
 * — no-hls도 restartScheduled를 세우므로 순서가 뒤집히면 "재시도"로 오분류된다.
 */
function resolveState(s: FrameCaptureSnapshot): FrameCaptureUiState {
  if (!s.enabled) {
    return "idle";
  }
  if (s.ffmpegMissing) {
    return "unavailable";
  }
  // 연결 해제된 provider가 잔류 사유로 거짓 "미지원/재시도"를 표시하는 것 방지
  // (stop 시 child는 kill이므로 capturing과 충돌하지 않는다)
  if (s.stopped) {
    return "idle";
  }
  if (s.capturing) {
    return "capturing";
  }
  if (s.lastFailureReason === "no-hls") {
    return "unsupported";
  }
  if (s.lastFailureReason === "spawn-error" || s.lastFailureReason === "ffmpeg-exit") {
    return "retrying";
  }
  return "idle";
}

/** 순수 매핑 함수 — 스냅샷을 UI 상태 + 표시 문구로 변환 */
export function computeCaptureStatus(s: FrameCaptureSnapshot): FrameCaptureStatus {
  const state = resolveState(s);
  return { state, message: STATE_MESSAGE[state], frameCount: s.frameCount };
}
