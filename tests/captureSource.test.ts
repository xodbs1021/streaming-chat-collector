import { describe, expect, it } from "vitest";
import {
  pickInitialCaptureProvider,
  runSingleFrameCapture,
  shouldCaptureLateJoin,
  shouldFallbackToSoop,
  type SingleFrameCaptureDeps
} from "../src/server/captureSource";
import type { CaptureReadiness } from "../src/shared/captureReadiness";
import type { BroadcastProviderRef, ChatProvider } from "../src/shared/types";

function ref(provider: ChatProvider): BroadcastProviderRef {
  return { provider, sourceMode: "unofficial", channelId: `${provider}-channel` };
}

const CHZZK = ref("chzzk");
const SOOP = ref("soop");

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

describe("shouldCaptureLateJoin", () => {
  it("captures when recording and the capture slot is empty", () => {
    expect(shouldCaptureLateJoin(true, undefined)).toBe(true);
  });

  it("is a no-op when the capture slot is already filled", () => {
    expect(shouldCaptureLateJoin(true, "chzzk")).toBe(false);
    expect(shouldCaptureLateJoin(true, "soop")).toBe(false);
  });

  it("is a no-op when not recording", () => {
    expect(shouldCaptureLateJoin(false, undefined)).toBe(false);
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
  slot: () => ChatProvider | undefined;
}

/**
 * runSingleFrameCapture용 페이크 — setActiveProvider가 세팅한 슬롯을 ensureCapture 호출 시점에
 * 기록해 "슬롯을 기동 직전에 set했는가"(순서)를 실질 검증한다. 잘못 set 순서면 slotAtCall이 어긋난다.
 */
function makeHarness(options: {
  readinessByProvider?: Partial<Record<ChatProvider, CaptureReadiness | undefined>>;
  soopRef?: BroadcastProviderRef | undefined;
}): Harness {
  let slot: ChatProvider | undefined;
  const events: string[] = [];
  const captureCalls: CaptureCall[] = [];
  const deps: SingleFrameCaptureDeps = {
    setActiveProvider: (provider) => {
      slot = provider;
      events.push(`set:${provider}`);
    },
    ensureCapture: async (target) => {
      captureCalls.push({ provider: target.provider, slotAtCall: slot });
      events.push(`ensure:${target.provider}`);
      return options.readinessByProvider?.[target.provider];
    },
    stopChzzkCapture: async () => {
      events.push("stop:chzzk");
    },
    soopRefIfConnected: () => options.soopRef
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

  it("fills the slot before starting capture and does not fall back when chzzk is ready", async () => {
    const harness = makeHarness({ readinessByProvider: { chzzk: "ready" }, soopRef: SOOP });
    await runSingleFrameCapture([CHZZK, SOOP], harness.deps);
    // 슬롯은 chzzk 기동 호출 직전에 이미 "chzzk"여야 한다 (순서 검증).
    expect(harness.captureCalls).toEqual([{ provider: "chzzk", slotAtCall: "chzzk" }]);
    expect(harness.events).toEqual(["set:chzzk", "ensure:chzzk"]);
    expect(harness.slot()).toBe("chzzk");
  });

  it("stops chzzk, re-points the slot to soop, then starts soop on a capture-failure readiness", async () => {
    const harness = makeHarness({ readinessByProvider: { chzzk: "no-hls" }, soopRef: SOOP });
    await runSingleFrameCapture([CHZZK, SOOP], harness.deps);
    expect(harness.events).toEqual(["set:chzzk", "ensure:chzzk", "stop:chzzk", "set:soop", "ensure:soop"]);
    // soop 기동 시점에 슬롯이 "soop"로 재지정되어 있어야 한다 (폴백 창에서도 슬롯 truthy 유지).
    expect(harness.captureCalls).toEqual([
      { provider: "chzzk", slotAtCall: "chzzk" },
      { provider: "soop", slotAtCall: "soop" }
    ]);
    expect(harness.slot()).toBe("soop");
  });

  it("does not fall back when chzzk fails but soop is not connected", async () => {
    const harness = makeHarness({ readinessByProvider: { chzzk: "no-hls" }, soopRef: undefined });
    await runSingleFrameCapture([CHZZK], harness.deps);
    expect(harness.events).toEqual(["set:chzzk", "ensure:chzzk"]);
    expect(harness.slot()).toBe("chzzk");
  });

  it("does not fall back when chzzk is the only capture and it stays ready", async () => {
    const harness = makeHarness({ readinessByProvider: { chzzk: "ready" }, soopRef: SOOP });
    await runSingleFrameCapture([CHZZK], harness.deps);
    expect(harness.events).toEqual(["set:chzzk", "ensure:chzzk"]);
  });

  it("does not fall back when a skip readiness (undefined) comes back for chzzk", async () => {
    const harness = makeHarness({ readinessByProvider: { chzzk: undefined }, soopRef: SOOP });
    await runSingleFrameCapture([CHZZK, SOOP], harness.deps);
    expect(harness.events).toEqual(["set:chzzk", "ensure:chzzk"]);
    expect(harness.slot()).toBe("chzzk");
  });

  it("captures soop directly (no chzzk fallback path) when chzzk is not connected", async () => {
    const harness = makeHarness({ readinessByProvider: { soop: "ready" }, soopRef: SOOP });
    await runSingleFrameCapture([SOOP], harness.deps);
    expect(harness.captureCalls).toEqual([{ provider: "soop", slotAtCall: "soop" }]);
    expect(harness.events).toEqual(["set:soop", "ensure:soop"]);
  });
});
