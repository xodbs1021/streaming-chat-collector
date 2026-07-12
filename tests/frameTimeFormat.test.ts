import { describe, expect, it } from "vitest";
import { formatFrameTimestamp } from "../src/client/components/dashboard/format";

// KST = UTC+9 고정(서머타임 없음) — 기대값은 에폭에서 손계산.
describe("formatFrameTimestamp", () => {
  it("formats a known epoch as KST with dot-separated date and colon-separated time", () => {
    // 2026-07-11 17:02:03 KST = 2026-07-11 08:02:03 UTC = 1783756923
    expect(formatFrameTimestamp(1783756923)).toBe("2026.07.11 17:02:03");
  });

  it("is independent of the host timezone (Asia/Seoul is pinned in the formatter)", () => {
    const original = process.env.TZ;
    try {
      for (const tz of ["UTC", "America/New_York"]) {
        process.env.TZ = tz;
        expect(formatFrameTimestamp(1783756923)).toBe("2026.07.11 17:02:03");
      }
    } finally {
      process.env.TZ = original;
    }
  });

  it("renders KST midnight as 00, not 24 (hourCycle h23)", () => {
    // 2026-07-12 00:00:00 KST = 2026-07-11 15:00:00 UTC = 1783782000
    expect(formatFrameTimestamp(1783782000)).toBe("2026.07.12 00:00:00");
  });

  it("rolls the date over at the KST day boundary", () => {
    // 2026-07-11 23:59:59 KST = 1783781999
    expect(formatFrameTimestamp(1783781999)).toBe("2026.07.11 23:59:59");
  });

  it("zero-pads single-digit month, day, hour, minute and second", () => {
    // 2026-01-05 03:04:05 KST = 2026-01-04 18:04:05 UTC = 1767549845
    expect(formatFrameTimestamp(1767549845)).toBe("2026.01.05 03:04:05");
  });
});
