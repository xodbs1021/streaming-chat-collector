import type { CaptureReadiness } from "../shared/captureReadiness";
import type { BroadcastProviderRef, ChatProvider } from "../shared/types";

/**
 * 한 방송에서 프레임을 캡처할 단일 소스를 고른다 — 치지직 우선, 없으면 연결된 첫 provider(=SOOP).
 * "표시 소스는 치지직 고정"(PR5)과 대칭으로 캡처 소스도 치지직을 기본으로 둔다. 연결이 없으면 undefined.
 */
export function pickInitialCaptureProvider(connected: BroadcastProviderRef[]): BroadcastProviderRef | undefined {
  return connected.find((ref) => ref.provider === "chzzk") ?? connected[0];
}

/** 치지직을 SOOP로 대체할 트리거가 되는 캡처 판정 — 스트림 자체가 안 잡히는(그러나 복구 가능성 있는) 상태 */
const FALLBACK_TRIGGER_READINESS: ReadonlySet<CaptureReadiness> = new Set(["no-hls", "stream-error", "timeout"]);

/**
 * 치지직 캡처 판정이 SOOP 대체를 요구하는지 결정한다.
 * 대체 트리거는 스트림 미확보({no-hls, stream-error, timeout})이고 SOOP가 연결돼 있을 때만.
 * ffmpeg-missing·disabled(전역 문제 — SOOP도 동일)와 cancelled(종료 중)는 대체하지 않는다.
 */
export function shouldFallbackToSoop(readiness: CaptureReadiness, isSoopConnected: boolean): boolean {
  return isSoopConnected && FALLBACK_TRIGGER_READINESS.has(readiness);
}

/**
 * 녹화 중 뒤늦게 붙은 provider의 캡처를 이 방송에 합류시킬지 판정한다.
 * 단일 소스 모드에서 슬롯이 비어 있을 때만(=시작 시 캡처 가능한 provider가 0이었던 경우) 합류시킨다.
 * (레거시 모드는 슬롯을 세팅하지 않아 항상 비어 있음 → 기존 이중 캡처 그대로 복원.)
 */
export function shouldCaptureLateJoin(isRecording: boolean, activeCaptureProvider: ChatProvider | undefined): boolean {
  return isRecording && activeCaptureProvider === undefined;
}

/** runSingleFrameCapture가 index.ts 런타임에 의존하는 부작용 계약(캡처 기동·중지·슬롯 세팅·SOOP 연결 조회) */
export interface SingleFrameCaptureDeps {
  /** 캡처 슬롯(activeCaptureProvider)을 지정한다 — 기동 호출 직전에 불러 슬롯을 truthy로 유지한다. */
  setActiveProvider: (provider: ChatProvider) => void;
  /** 한 provider의 프레임 캡처를 방송 폴더로 기동하고 기동 판정을 돌려준다(스킵 시 undefined). */
  ensureCapture: (ref: BroadcastProviderRef) => Promise<CaptureReadiness | undefined>;
  /** 폴백 시 치지직 캡처 매니저를 중지한다(SOOP 단일 소스로 넘어가기 위해). */
  stopChzzkCapture: () => Promise<void>;
  /** 현재 SOOP가 연결돼 있으면 그 ref를, 아니면 undefined를 돌려준다(폴백 대상). */
  soopRefIfConnected: () => BroadcastProviderRef | undefined;
}

/**
 * 단일 소스 프레임 캡처 오케스트레이션 — 치지직을 먼저 기동하고, 스트림이 안 잡히면 SOOP로 대체한다.
 * 슬롯은 항상 기동 호출 직전에 set해(폴백 창 포함) late-join 이중 기동을 막는다.
 * 호출부는 fire-and-forget(void)으로 돌려 emitRecordingStatus를 캡처 대기 뒤로 밀지 않는다 [R1].
 */
export async function runSingleFrameCapture(
  connected: BroadcastProviderRef[],
  deps: SingleFrameCaptureDeps
): Promise<void> {
  const chosen = pickInitialCaptureProvider(connected);
  if (!chosen) {
    return;
  }
  deps.setActiveProvider(chosen.provider);
  const readiness = await deps.ensureCapture(chosen);
  // 폴백은 치지직으로 시작했을 때만 — SOOP를 이미 골랐으면 대체할 대상이 없다.
  if (chosen.provider !== "chzzk" || !readiness) {
    return;
  }
  const soopRef = deps.soopRefIfConnected();
  // soopRef가 있으면 SOOP는 연결된 것 — shouldFallbackToSoop의 연결 인자는 여기서 true로 확정된다.
  if (!soopRef || !shouldFallbackToSoop(readiness, true)) {
    return;
  }
  await deps.stopChzzkCapture();
  deps.setActiveProvider("soop");
  await deps.ensureCapture(soopRef);
}
