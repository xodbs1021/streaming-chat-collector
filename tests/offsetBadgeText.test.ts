import { describe, expect, it } from "vitest";
import { formatOffsetSeconds, liveOffsetBadge, mergedOffsetBadge } from "../src/client/components/dashboard/offsetBadgeText";
import type { BroadcastOffset, LiveOffsetStatus, OffsetSegment } from "../src/shared/types";

function segment(patch: Partial<OffsetSegment>): OffsetSegment {
  return { startAt: 0, endAt: 600_000, offsetMs: 0, confidence: 0.5, carried: false, ...patch };
}

function offset(segments: OffsetSegment[]): BroadcastOffset {
  return { version: 1, anchor: "chzzk", target: "soop", computedAt: 0, params: { windowSec: 600, binSec: 1, searchSec: 60, reestimateSec: 60 }, segments };
}

describe("formatOffsetSeconds", () => {
  it("음수 offset(SOOP 늦음)을 초 단위로", () => {
    expect(formatOffsetSeconds(-8_400)).toBe("-8.4초");
    expect(formatOffsetSeconds(-8_000)).toBe("-8.0초");
  });

  it("양수 offset(SOOP 빠름)에 + 부호", () => {
    expect(formatOffsetSeconds(3_000)).toBe("+3.0초");
  });
});

describe("liveOffsetBadge", () => {
  it("상태 없음/추정 중이면 '싱크 계산 중'", () => {
    expect(liveOffsetBadge(undefined)).toEqual({ tone: "estimating", text: "싱크 계산 중" });
    const estimating: LiveOffsetStatus = { estimating: true, segmentCount: 0, carriedCount: 0 };
    expect(liveOffsetBadge(estimating).tone).toBe("estimating");
  });

  it("신뢰 offset이 잡히면 싱크 값을 보여준다", () => {
    const status: LiveOffsetStatus = { estimating: false, offsetMs: -8_400, confidence: 0.7, segmentCount: 1, carriedCount: 0 };
    expect(liveOffsetBadge(status)).toEqual({ tone: "known", text: "SOOP 싱크 -8.4초" });
  });
});

describe("mergedOffsetBadge", () => {
  it("활성(녹화 중) 방송이면 '방송 진행 중 — 종료 후 정렬'", () => {
    expect(mergedOffsetBadge(undefined, true)).toEqual({ tone: "estimating", text: "방송 진행 중 — 종료 후 정렬" });
  });

  it("마커 없으면(offset 부재) '보정 기록 없음'", () => {
    expect(mergedOffsetBadge(undefined, false)).toEqual({ tone: "none", text: "보정 기록 없음" });
  });

  it("구간 수·추정(carried) 수와 대표 offset을 요약한다", () => {
    const segments = [
      segment({ offsetMs: -8_400, confidence: 0.8, carried: false }),
      segment({ offsetMs: -8_000, confidence: 0.3, carried: true }),
      segment({ offsetMs: -7_500, confidence: 0.2, carried: true }),
      segment({ offsetMs: -8_100, confidence: 0.6, carried: false }),
      segment({ offsetMs: -8_200, confidence: 0.5, carried: false }),
      segment({ offsetMs: -8_300, confidence: 0.4, carried: false })
    ];
    // 대표 offset = 최고 신뢰 구간(-8400), 6구간 중 2개 추정
    expect(mergedOffsetBadge(offset(segments), false)).toEqual({
      tone: "known",
      text: "SOOP 싱크 -8.4초 · 구간 6(추정 2)"
    });
  });

  it("추정 구간이 없으면 (추정 N)을 생략한다", () => {
    const segments = [segment({ offsetMs: -8_000, confidence: 0.7, carried: false })];
    expect(mergedOffsetBadge(offset(segments), false).text).toBe("SOOP 싱크 -8.0초 · 구간 1");
  });
});
