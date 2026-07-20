import type { CaptureReadiness } from "../shared/captureReadiness";
import type { BroadcastProviderRef, ChatProvider } from "../shared/types";

/**
 * 캡처 슬롯 — 어느 방송이 어느 소스로 프레임을 캡처 중인지. 방송 스코프(broadcastId)로 묶어
 * "빠른 종료→재시작"에서 이전 방송의 폴백/finalize가 다음 방송의 슬롯·디렉토리를 침범하지 못하게 한다.
 */
export interface CaptureSlot {
  broadcastId: string;
  provider: ChatProvider;
}

/** 슬롯이 지정한 방송을 소유하는지 — 소유권 재확인·finalize 리셋 판정의 단일 진실원 */
export function captureSlotOwns(slot: CaptureSlot | undefined, activeBroadcastId: string | undefined): boolean {
  return slot !== undefined && activeBroadcastId !== undefined && slot.broadcastId === activeBroadcastId;
}

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
 * 현재 방송을 소유한 슬롯이 없을 때만(=시작 시 캡처 가능한 provider가 0이었거나 슬롯이 스테일일 때) 합류시킨다.
 * (레거시 모드는 슬롯을 세팅하지 않아 항상 미소유 → 기존 이중 캡처 그대로 복원.)
 */
export function shouldCaptureLateJoin(
  isRecording: boolean,
  slot: CaptureSlot | undefined,
  activeBroadcastId: string | undefined
): boolean {
  return isRecording && !captureSlotOwns(slot, activeBroadcastId);
}

/**
 * 고아가 된 선기동 캡처가 provider 싱글턴 매니저를 stop해도 되는지 판정한다.
 * 매니저 기동 시 소유 broadcastId를 기록해두고, 여전히 내 방송이 소유 중일 때만 stop한다.
 *   - 내 소유(managerOwner === myBroadcastId): 다음 방송이 재기동하지 않았음 → 내 고아 캡처를 stop해도 안전(R3).
 *   - 다른 방송 소유(≠): 다음 방송이 같은 매니저를 이미 재기동함 → 그 방송의 새 캡처를 죽이면 안 되므로 stop 금지.
 *   - 미소유(undefined): 소유자 없음 → stop 금지.
 */
export function shouldStopOrphanedManager(
  managerOwner: string | undefined,
  myBroadcastId: string
): boolean {
  return managerOwner === myBroadcastId;
}

/** runSingleFrameCapture가 index.ts 런타임에 의존하는 부작용 계약(캡처 기동·중지·슬롯 세팅·소유권·SOOP 조회) */
export interface SingleFrameCaptureDeps {
  /** 이 체인이 소유한 방송 id — 슬롯을 이 방송 스코프로 minting한다. */
  broadcastId: string;
  /** 캡처 슬롯을 지정한다 — 기동 호출 직전에 불러 슬롯을 truthy로 유지한다. */
  setSlot: (slot: CaptureSlot) => void;
  /** 한 provider의 프레임 캡처를 방송 폴더로 기동하고 기동 판정을 돌려준다(스킵 시 undefined). */
  ensureCapture: (ref: BroadcastProviderRef) => Promise<CaptureReadiness | undefined>;
  /** 폴백 시 치지직 캡처 매니저를 중지한다(SOOP 단일 소스로 넘어가기 위해). */
  stopChzzkCapture: () => Promise<void>;
  /** 현재 SOOP가 연결돼 있으면 그 ref를, 아니면 undefined를 돌려준다(폴백 대상). */
  soopRefIfConnected: () => BroadcastProviderRef | undefined;
  /** 이 체인의 방송이 아직 진행 중인지(다음 방송으로 넘어가지 않았는지) — 모든 await 뒤 재확인. */
  isActiveBroadcast: () => boolean;
}

/**
 * 단일 소스 프레임 캡처 오케스트레이션 — 치지직을 먼저 기동하고, 스트림이 안 잡히면 SOOP로 대체한다.
 * 슬롯은 항상 기동 호출 직전에 set해(폴백 창 포함) late-join 이중 기동을 막는다.
 * 모든 await(캡처 대기·stop) 뒤 소유권(isActiveBroadcast)을 재확인해, 대기 중 이 방송이 끝나고 다음 방송이
 * 시작됐으면 체인을 중단한다 — 이전 방송 체인이 다음 방송의 슬롯·프레임 디렉토리를 침범하지 못하게 한다.
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
  deps.setSlot({ broadcastId: deps.broadcastId, provider: chosen.provider });
  const readiness = await deps.ensureCapture(chosen);
  // 캡처 대기 뒤 소유권 재확인 — 대기 중 방송이 바뀌었으면 폴백을 시작하지 않는다.
  if (!deps.isActiveBroadcast()) {
    return;
  }
  // 폴백은 치지직으로 시작했을 때만 — SOOP를 이미 골랐으면 대체할 대상이 없다.
  if (chosen.provider !== "chzzk" || !readiness) {
    return;
  }
  // stop 전 SOOP 연결 스냅샷으로 대체 가치를 판정한다(연결 없으면 치지직 캡처를 죽일 이유 없음).
  if (!shouldFallbackToSoop(readiness, deps.soopRefIfConnected() !== undefined)) {
    return;
  }
  await deps.stopChzzkCapture();
  // stop 뒤 소유권 재확인 + SOOP 재조회(스냅샷 stale 방지) — 방송이 바뀌었거나 SOOP가 끊겼으면 중단.
  if (!deps.isActiveBroadcast()) {
    return;
  }
  const soopRef = deps.soopRefIfConnected();
  if (!soopRef) {
    return;
  }
  deps.setSlot({ broadcastId: deps.broadcastId, provider: "soop" });
  await deps.ensureCapture(soopRef);
}
