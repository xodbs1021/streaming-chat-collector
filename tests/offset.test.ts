import { describe, expect, it } from "vitest";
import { offsetAtTime, toAnchorTimestamp } from "../src/shared/offset";
import type { OffsetSegment } from "../src/shared/types";

function segment(patch: Partial<OffsetSegment>): OffsetSegment {
  return { startAt: 0, endAt: 600_000, offsetMs: 0, confidence: 1, carried: false, ...patch };
}

describe("offset 부호 규약 (anchorTime = soopTime + offsetMs)", () => {
  // 1호 회귀 테스트 — 부호를 못 박는다. SOOP이 8초 늦으면(soopTime = anchorTime + 8000)
  // offsetMs = −8000이어야 anchorTime으로 되돌아온다.
  it("SOOP이 8초 늦은 레코드를 offsetMs=−8000으로 anchor 축에 되돌린다", () => {
    const anchorTime = 1_000_000;
    const soopTime = anchorTime + 8_000; // SOOP은 8초 늦게 찍힌다
    const segments = [segment({ startAt: 0, endAt: 2_000_000, offsetMs: -8_000 })];

    expect(toAnchorTimestamp(soopTime, segments)).toBe(anchorTime);
  });

  it("SOOP이 8초 빠른 레코드는 offsetMs=+8000으로 뒤로 민다", () => {
    const anchorTime = 1_000_000;
    const soopTime = anchorTime - 8_000;
    const segments = [segment({ startAt: 0, endAt: 2_000_000, offsetMs: 8_000 })];

    expect(toAnchorTimestamp(soopTime, segments)).toBe(anchorTime);
  });
});

describe("offsetAtTime", () => {
  it("구간이 없으면 0(무보정)을 돌려준다", () => {
    expect(offsetAtTime([], 123)).toBe(0);
  });

  it("시각을 포함하는 구간의 offsetMs를 고른다", () => {
    const segments = [
      segment({ startAt: 0, endAt: 600_000, offsetMs: -3_000 }),
      segment({ startAt: 600_000, endAt: 1_200_000, offsetMs: -5_000 })
    ];
    expect(offsetAtTime(segments, 300_000)).toBe(-3_000);
    expect(offsetAtTime(segments, 600_000)).toBe(-5_000);
    expect(offsetAtTime(segments, 900_000)).toBe(-5_000);
  });

  it("첫 구간 앞은 첫 구간, 마지막 구간 뒤는 마지막 구간으로 클램프한다(선두/후미 backfill)", () => {
    const segments = [
      segment({ startAt: 100_000, endAt: 700_000, offsetMs: -3_000 }),
      segment({ startAt: 700_000, endAt: 1_300_000, offsetMs: -6_000 })
    ];
    expect(offsetAtTime(segments, 0)).toBe(-3_000); // 앞
    expect(offsetAtTime(segments, 5_000_000)).toBe(-6_000); // 뒤
  });
});
