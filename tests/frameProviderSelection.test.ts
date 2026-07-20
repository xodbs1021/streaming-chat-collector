import { describe, expect, it } from "vitest";
import {
  dominantProvider,
  filterAvailableSeconds,
  otherProvider,
  resolveAvailableFrames,
  resolvePrimaryProvider,
  resolveSessionFallbackProvider,
  sumProviderCounts
} from "../src/client/frameProviderSelection";

describe("dominantProvider", () => {
  it("picks chzzk when it has more messages", () => {
    expect(dominantProvider({ chzzk: 10, soop: 3 })).toBe("chzzk");
  });

  it("picks soop when it has more messages", () => {
    expect(dominantProvider({ chzzk: 2, soop: 9 })).toBe("soop");
  });

  it("prefers chzzk on a tie", () => {
    expect(dominantProvider({ chzzk: 5, soop: 5 })).toBe("chzzk");
  });

  it("returns undefined when both are zero or missing", () => {
    expect(dominantProvider({})).toBeUndefined();
    expect(dominantProvider({ chzzk: 0, soop: 0 })).toBeUndefined();
  });

  it("handles a single populated provider", () => {
    expect(dominantProvider({ soop: 4 })).toBe("soop");
  });
});

describe("resolvePrimaryProvider", () => {
  it("returns the dominant provider when counts have messages", () => {
    expect(resolvePrimaryProvider({ chzzk: 10, soop: 3 }, "soop")).toBe("chzzk");
  });

  it("falls back to the session provider when counts are empty (the SOOP session regression)", () => {
    expect(resolvePrimaryProvider({}, "soop")).toBe("soop");
    expect(resolvePrimaryProvider({ chzzk: 0, soop: 0 }, "soop")).toBe("soop");
  });

  it("falls back to chzzk when counts are empty and no session provider (live merged view)", () => {
    expect(resolvePrimaryProvider({})).toBe("chzzk");
    expect(resolvePrimaryProvider({ chzzk: 0, soop: 0 }, undefined)).toBe("chzzk");
  });

  it("prefers the dominant provider over the session provider when counts exist", () => {
    expect(resolvePrimaryProvider({ soop: 5 }, "chzzk")).toBe("soop");
  });
});

describe("resolveSessionFallbackProvider", () => {
  it("returns undefined for the live merged view so its dominant→chzzk fallback stays intact", () => {
    expect(resolveSessionFallbackProvider("live", "soop")).toBeUndefined();
    expect(resolveSessionFallbackProvider("live", undefined)).toBeUndefined();
  });

  it("returns the session provider for a session tab (its empty-window frame fallback uses it)", () => {
    expect(resolveSessionFallbackProvider("session-123", "soop")).toBe("soop");
    expect(resolveSessionFallbackProvider("session-abc", "chzzk")).toBe("chzzk");
  });

  it("returns undefined for a session tab whose provider is unknown", () => {
    expect(resolveSessionFallbackProvider("session-123", undefined)).toBeUndefined();
  });
});

describe("otherProvider", () => {
  it("flips chzzk to soop and back", () => {
    expect(otherProvider("chzzk")).toBe("soop");
    expect(otherProvider("soop")).toBe("chzzk");
  });
});

describe("sumProviderCounts", () => {
  it("sums provider counts across windows", () => {
    const windows = [{ providerCounts: { chzzk: 3, soop: 1 } }, { providerCounts: { chzzk: 2 } }, { providerCounts: {} }];
    expect(sumProviderCounts(windows)).toEqual({ chzzk: 5, soop: 1 });
  });

  it("returns an empty object for no windows", () => {
    expect(sumProviderCounts([])).toEqual({});
  });
});

describe("filterAvailableSeconds", () => {
  it("keeps only candidates that resolve to a real captured second", () => {
    // 5초 구간 후보 중 실제로는 101, 103초만 캡처됨 (ffmpeg 공백 흉내)
    const candidates = [100, 101, 102, 103, 104];
    const available = [101, 103];
    expect(filterAvailableSeconds(candidates, available)).toEqual([101, 103]);
  });

  it("deduplicates candidates that resolve to the same real second", () => {
    const candidates = [100, 101];
    const available = [95];
    expect(filterAvailableSeconds(candidates, available)).toEqual([95]);
  });

  it("returns an empty array when nothing is within tolerance", () => {
    expect(filterAvailableSeconds([100, 101], [1000])).toEqual([]);
  });

  it("returns an empty array when no frames were ever captured", () => {
    expect(filterAvailableSeconds([100, 101, 102], [])).toEqual([]);
  });
});

describe("resolveAvailableFrames", () => {
  it("uses the primary provider when it has real frames", () => {
    const result = resolveAvailableFrames([100, 101, 102], { chzzk: [100, 101], soop: [] }, "chzzk", "soop");
    expect(result).toEqual({ provider: "chzzk", seconds: [100, 101] });
  });

  it("falls back to the other provider when the primary has none", () => {
    const result = resolveAvailableFrames([100, 101, 102], { chzzk: [], soop: [101] }, "chzzk", "soop");
    expect(result).toEqual({ provider: "soop", seconds: [101] });
  });

  it("returns the primary with empty seconds when neither has frames", () => {
    const result = resolveAvailableFrames([100, 101], { chzzk: [], soop: [] }, "chzzk", "soop");
    expect(result).toEqual({ provider: "chzzk", seconds: [] });
  });
});
