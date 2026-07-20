import { describe, expect, it } from "vitest";
import {
  captureSlotOwns,
  pickInitialCaptureProvider,
  resolveManagersToStopOnFinalize,
  runSingleFrameCapture,
  shouldCaptureLateJoin,
  shouldFallbackToSoop,
  shouldStopOrphanedManager,
  type CaptureSlot,
  type SingleFrameCaptureDeps
} from "../src/server/captureSource";
import type { CaptureReadiness } from "../src/shared/captureReadiness";
import type { BroadcastProviderRef, ChatProvider } from "../src/shared/types";

function ref(provider: ChatProvider): BroadcastProviderRef {
  return { provider, sourceMode: "unofficial", channelId: `${provider}-channel` };
}

const CHZZK = ref("chzzk");
const SOOP = ref("soop");
const BROADCAST = "bc-A";

describe("pickInitialCaptureProvider", () => {
  it("prefers chzzk when both providers are connected", () => {
    expect(pickInitialCaptureProvider([SOOP, CHZZK])).toBe(CHZZK);
  });

  it("returns chzzk when only chzzk is connected", () => {
    expect(pickInitialCaptureProvider([CHZZK])).toBe(CHZZK);
  });

  it("returns soop when only soop is connected", () => {
    expect(pickInitialCaptureProvider([SOOP])).toBe(SOOP);
  });

  it("returns undefined when nothing is connected", () => {
    expect(pickInitialCaptureProvider([])).toBeUndefined();
  });
});

describe("shouldFallbackToSoop", () => {
  const triggers: CaptureReadiness[] = ["no-hls", "stream-error", "timeout"];
  const nonTriggers: CaptureReadiness[] = ["ready", "ffmpeg-missing", "disabled", "cancelled"];

  it("falls back for each capture-failure readiness when soop is connected", () => {
    for (const readiness of triggers) {
      expect(shouldFallbackToSoop(readiness, true)).toBe(true);
    }
  });

  it("does not fall back for a failure readiness when soop is not connected", () => {
    for (const readiness of triggers) {
      expect(shouldFallbackToSoop(readiness, false)).toBe(false);
    }
  });

  it("never falls back for global/terminal readinesses even when soop is connected", () => {
    for (const readiness of nonTriggers) {
      expect(shouldFallbackToSoop(readiness, true)).toBe(false);
    }
  });
});

describe("captureSlotOwns", () => {
  it("owns the slot when the broadcast ids match", () => {
    expect(captureSlotOwns({ broadcastId: "A", provider: "chzzk" }, "A")).toBe(true);
  });

  it("does not own a slot minted for a different broadcast", () => {
    expect(captureSlotOwns({ broadcastId: "A", provider: "chzzk" }, "B")).toBe(false);
  });

  it("does not own an empty slot", () => {
    expect(captureSlotOwns(undefined, "A")).toBe(false);
  });

  it("does not own when the active broadcast id is unknown", () => {
    expect(captureSlotOwns({ broadcastId: "A", provider: "chzzk" }, undefined)).toBe(false);
  });
});

describe("shouldCaptureLateJoin", () => {
  const slotA: CaptureSlot = { broadcastId: "A", provider: "chzzk" };

  it("captures when recording and no slot owns the active broadcast", () => {
    expect(shouldCaptureLateJoin(true, undefined, "A")).toBe(true);
  });

  it("is a no-op when a slot already owns the active broadcast", () => {
    expect(shouldCaptureLateJoin(true, slotA, "A")).toBe(false);
  });

  it("captures (self-heals) when the only slot belongs to a stale broadcast", () => {
    expect(shouldCaptureLateJoin(true, slotA, "B")).toBe(true);
  });

  it("is a no-op when not recording", () => {
    expect(shouldCaptureLateJoin(false, undefined, "A")).toBe(false);
  });
});

interface CaptureCall {
  provider: ChatProvider;
  slotAtCall: ChatProvider | undefined;
}

interface Harness {
  deps: SingleFrameCaptureDeps;
  events: string[];
  captureCalls: CaptureCall[];
  slot: () => CaptureSlot | undefined;
}

interface HarnessOptions {
  broadcastId?: string;
  readinessByProvider?: Partial<Record<ChatProvider, CaptureReadiness | undefined>>;
  soopRef?: BroadcastProviderRef | undefined;
  /** 이 provider의 ensureCapture 대기 중 소유권 상실(방송 전환)을 시뮬레이션한다. */
  loseOwnershipOnEnsure?: ChatProvider;
  /** 치지직 stop 대기 중 소유권 상실을 시뮬레이션한다. */
  loseOwnershipOnStop?: boolean;
  /** stop 이후 soopRefIfConnected 재조회 값(스냅샷 stale 검증용). 키가 있으면 stop 후 이 값으로 바뀐다. */
  soopRefAfterStop?: BroadcastProviderRef | undefined;
}

/**
 * runSingleFrameCapture용 페이크 — setSlot이 세팅한 슬롯을 ensureCapture 호출 시점에 기록해
 * "슬롯을 기동 직전에 set했는가"(순서)와 방송 스코프 소유권 재확인을 실질 검증한다.
 */
function makeHarness(options: HarnessOptions): Harness {
  const broadcastId = options.broadcastId ?? BROADCAST;
  let slot: CaptureSlot | undefined;
  let owned = true;
  let stopped = false;
  const events: string[] = [];
  const captureCalls: CaptureCall[] = [];
  const deps: SingleFrameCaptureDeps = {
    broadcastId,
    setSlot: (next) => {
      slot = next;
      events.push(`set:${next.provider}`);
    },
    ensureCapture: async (target) => {
      captureCalls.push({ provider: target.provider, slotAtCall: slot?.provider });
      events.push(`ensure:${target.provider}`);
      if (options.loseOwnershipOnEnsure === target.provider) {
        owned = false;
      }
      return options.readinessByProvider?.[target.provider];
    },
    stopChzzkCapture: async () => {
      events.push("stop:chzzk");
      stopped = true;
      if (options.loseOwnershipOnStop) {
        owned = false;
      }
    },
    soopRefIfConnected: () =>
      stopped && "soopRefAfterStop" in options ? options.soopRefAfterStop : options.soopRef,
    isActiveBroadcast: () => owned
  };
  return { deps, events, captureCalls, slot: () => slot };
}

describe("runSingleFrameCapture", () => {
  it("does nothing when no provider is connected", async () => {
    const harness = makeHarness({});
    await runSingleFrameCapture([], harness.deps);
    expect(harness.events).toEqual([]);
    expect(harness.slot()).toBeUndefined();
  });

  it("fills the slot (broadcast-scoped) before starting capture and does not fall back when chzzk is ready", async () => {
    const harness = makeHarness({ readinessByProvider: { chzzk: "ready" }, soopRef: SOOP });
    await runSingleFrameCapture([CHZZK, SOOP], harness.deps);
    expect(harness.captureCalls).toEqual([{ provider: "chzzk", slotAtCall: "chzzk" }]);
    expect(harness.events).toEqual(["set:chzzk", "ensure:chzzk"]);
    expect(harness.slot()).toEqual({ broadcastId: BROADCAST, provider: "chzzk" });
  });

  it("stops chzzk, re-points the slot to soop, then starts soop on a capture-failure readiness", async () => {
    const harness = makeHarness({ readinessByProvider: { chzzk: "no-hls" }, soopRef: SOOP });
    await runSingleFrameCapture([CHZZK, SOOP], harness.deps);
    expect(harness.events).toEqual(["set:chzzk", "ensure:chzzk", "stop:chzzk", "set:soop", "ensure:soop"]);
    expect(harness.captureCalls).toEqual([
      { provider: "chzzk", slotAtCall: "chzzk" },
      { provider: "soop", slotAtCall: "soop" }
    ]);
    expect(harness.slot()).toEqual({ broadcastId: BROADCAST, provider: "soop" });
  });

  it("does not fall back when chzzk fails but soop is not connected", async () => {
    const harness = makeHarness({ readinessByProvider: { chzzk: "no-hls" }, soopRef: undefined });
    await runSingleFrameCapture([CHZZK], harness.deps);
    expect(harness.events).toEqual(["set:chzzk", "ensure:chzzk"]);
    expect(harness.slot()).toEqual({ broadcastId: BROADCAST, provider: "chzzk" });
  });

  it("does not fall back when a skip readiness (undefined) comes back for chzzk", async () => {
    const harness = makeHarness({ readinessByProvider: { chzzk: undefined }, soopRef: SOOP });
    await runSingleFrameCapture([CHZZK, SOOP], harness.deps);
    expect(harness.events).toEqual(["set:chzzk", "ensure:chzzk"]);
    expect(harness.slot()).toEqual({ broadcastId: BROADCAST, provider: "chzzk" });
  });

  it("captures soop directly (no chzzk fallback path) when chzzk is not connected", async () => {
    const harness = makeHarness({ readinessByProvider: { soop: "ready" }, soopRef: SOOP });
    await runSingleFrameCapture([SOOP], harness.deps);
    expect(harness.captureCalls).toEqual([{ provider: "soop", slotAtCall: "soop" }]);
    expect(harness.events).toEqual(["set:soop", "ensure:soop"]);
  });

  // ── deferred-stop 회귀: A 폴백 대기 중 A 종료→B 시작 시 A 체인이 B를 침범하지 않아야 한다 ──
  it("aborts the fallback chain when ownership is lost during the chzzk capture wait (does not stop chzzk or touch soop)", async () => {
    const harness = makeHarness({
      readinessByProvider: { chzzk: "no-hls" },
      soopRef: SOOP,
      loseOwnershipOnEnsure: "chzzk"
    });
    await runSingleFrameCapture([CHZZK, SOOP], harness.deps);
    // chzzk 대기 뒤 소유권 재확인에서 이탈 — stop/soop 아무것도 하지 않는다.
    expect(harness.events).toEqual(["set:chzzk", "ensure:chzzk"]);
    expect(harness.captureCalls).toEqual([{ provider: "chzzk", slotAtCall: "chzzk" }]);
  });

  it("aborts after stopping chzzk when ownership is lost during the stop wait (never starts soop)", async () => {
    const harness = makeHarness({
      readinessByProvider: { chzzk: "no-hls" },
      soopRef: SOOP,
      loseOwnershipOnStop: true
    });
    await runSingleFrameCapture([CHZZK, SOOP], harness.deps);
    // stop 뒤 소유권 재확인에서 이탈 — soop 슬롯 재지정·기동을 하지 않는다(다음 방송 슬롯 미침범).
    expect(harness.events).toEqual(["set:chzzk", "ensure:chzzk", "stop:chzzk"]);
    expect(harness.slot()).toEqual({ broadcastId: BROADCAST, provider: "chzzk" });
  });

  it("re-queries soop after stopping chzzk and aborts if soop disconnected in the meantime (stale snapshot)", async () => {
    const harness = makeHarness({
      readinessByProvider: { chzzk: "no-hls" },
      soopRef: SOOP,
      soopRefAfterStop: undefined
    });
    await runSingleFrameCapture([CHZZK, SOOP], harness.deps);
    expect(harness.events).toEqual(["set:chzzk", "ensure:chzzk", "stop:chzzk"]);
    expect(harness.captureCalls).toEqual([{ provider: "chzzk", slotAtCall: "chzzk" }]);
  });
});

describe("shouldStopOrphanedManager", () => {
  it("stops when this broadcast still owns the manager (cleans its own orphan capture — R3 double-click)", () => {
    expect(shouldStopOrphanedManager("bc-A", "bc-A")).toBe(true);
  });

  // deferred-stop 회귀: A의 폴링 재개 시점에 매니저 소유자가 B(다음 방송)면 A는 stop하면 안 된다 —
  // B가 같은 provider 싱글턴을 이미 재기동했으므로 B의 새 캡처를 죽이면 안 된다.
  it("does not stop when a newer broadcast has already claimed (re-armed) the manager", () => {
    expect(shouldStopOrphanedManager("bc-B", "bc-A")).toBe(false);
  });

  it("does not stop when no broadcast owns the manager", () => {
    expect(shouldStopOrphanedManager(undefined, "bc-A")).toBe(false);
  });
});

describe("resolveManagersToStopOnFinalize", () => {
  it("stops every manager the ended broadcast still owns", () => {
    expect(resolveManagersToStopOnFinalize({ chzzk: "bc-A", soop: "bc-A" }, "bc-A")).toEqual(["chzzk", "soop"]);
  });

  // 선재 경합 회귀: finalize(A) 드레인 창에서 B가 chzzk 매니저를 선점(재기동)하면, A의 finalize는
  // chzzk를 stop하면 안 된다(B의 새 캡처를 죽임). A가 아직 소유한 soop만 stop한다.
  it("spares a manager a newer broadcast has already re-armed (finalize(A) must not stop B's capture)", () => {
    expect(resolveManagersToStopOnFinalize({ chzzk: "bc-B", soop: "bc-A" }, "bc-A")).toEqual(["soop"]);
  });

  it("stops nothing when no manager is owned by the ended broadcast", () => {
    expect(resolveManagersToStopOnFinalize({ chzzk: undefined, soop: "bc-B" }, "bc-A")).toEqual([]);
  });
});
