import { describe, expect, it } from "vitest";
import {
  DEFAULT_ESTIMATOR_PARAMS,
  estimateOffsetSegments,
  estimateWindowOffset
} from "../src/server/offset/offsetEstimator";

/**
 * 봉우리 있는 합성 채팅을 만든다 — 상관에는 구조(변동)가 필요하므로 균일 분포가 아니라
 * 지정 초에 뭉치는 버스트로 생성한다. 같은 초 안(0~999ms)에 몰아넣어 1초 bin에 정확히 떨어지게 한다.
 */
function bursts(centersSec: number[], perBurst: number, startMs = 0): number[] {
  const times: number[] = [];
  for (const center of centersSec) {
    for (let i = 0; i < perBurst; i += 1) {
      times.push(startMs + center * 1000 + ((i * 37) % 1000));
    }
  }
  return times;
}

function shift(times: number[], deltaMs: number): number[] {
  return times.map((time) => time + deltaMs);
}

const CENTERS = [30, 95, 140, 220, 310, 400, 470, 550];

describe("estimateWindowOffset", () => {
  it("SOOP이 8초 늦은 합성 데이터에서 offsetMs≈−8000을 복원한다(부호)", () => {
    const chzzk = bursts(CENTERS, 8);
    const soop = shift(chzzk, 8_000); // SOOP 8초 늦음

    const result = estimateWindowOffset(chzzk, soop, 0, 600_000, DEFAULT_ESTIMATOR_PARAMS);

    expect(result).toBeDefined();
    expect(Math.abs((result?.offsetMs ?? 0) - -8_000)).toBeLessThanOrEqual(1_000);
    expect(result?.confidence ?? 0).toBeGreaterThan(0.1);
  });

  it("SOOP이 5초 빠르면 offsetMs≈+5000을 복원한다", () => {
    const chzzk = bursts(CENTERS, 8);
    const soop = shift(chzzk, -5_000);

    const result = estimateWindowOffset(chzzk, soop, 0, 600_000, DEFAULT_ESTIMATOR_PARAMS);

    expect(Math.abs((result?.offsetMs ?? 0) - 5_000)).toBeLessThanOrEqual(1_000);
  });

  it("한쪽이 조용하면(증거 부족) undefined", () => {
    const chzzk = bursts(CENTERS, 8);
    expect(estimateWindowOffset(chzzk, [100, 200], 0, 600_000, DEFAULT_ESTIMATOR_PARAMS)).toBeUndefined();
  });

  it("chzzk 소수 오염(Date.now 폴백 흉내)에도 진짜 봉우리가 지배해 offset을 복원한다", () => {
    const chzzk = bursts(CENTERS, 10);
    // 전체의 ~12%를 한 초에 몰아 찍는 오염(=Date.now 폴백이 한 시점으로 쏠린 흉내)
    const contaminated = [...chzzk, ...bursts([580], 14)];
    const soop = shift(chzzk, 8_000);

    const result = estimateWindowOffset(contaminated, soop, 0, 600_000, DEFAULT_ESTIMATOR_PARAMS);

    expect(Math.abs((result?.offsetMs ?? 0) - -8_000)).toBeLessThanOrEqual(1_000);
  });
});

describe("estimateOffsetSegments", () => {
  it("데이터가 없으면 []", () => {
    expect(estimateOffsetSegments([], [])).toEqual([]);
  });

  it("신뢰 구간이 하나도 없으면 []", () => {
    expect(estimateOffsetSegments([100, 200], [150, 250])).toEqual([]);
  });

  it("단일 offset 방송 — 전 구간을 하나의 offset(≈−8000, carried=false)으로 복원한다", () => {
    const chzzk = bursts(CENTERS, 10);
    const soop = shift(chzzk, 8_000);

    const segments = estimateOffsetSegments(chzzk, soop);

    expect(segments.length).toBeGreaterThanOrEqual(1);
    expect(segments.every((segment) => !segment.carried)).toBe(true);
    expect(Math.abs(segments[0].offsetMs - -8_000)).toBeLessThanOrEqual(1_000);
  });

  it("드리프트 — 앞 구간과 뒤 구간의 서로 다른 offset을 구간별로 복원한다", () => {
    const firstChzzk = bursts(CENTERS, 10, 0);
    const secondChzzk = bursts(CENTERS, 10, 600_000);
    const chzzk = [...firstChzzk, ...secondChzzk];
    const soop = [...shift(firstChzzk, 8_000), ...shift(secondChzzk, 3_000)];

    const segments = estimateOffsetSegments(chzzk, soop);

    expect(segments.length).toBeGreaterThanOrEqual(2);
    expect(Math.abs(segments[0].offsetMs - -8_000)).toBeLessThanOrEqual(1_000);
    expect(Math.abs(segments[segments.length - 1].offsetMs - -3_000)).toBeLessThanOrEqual(1_000);
  });

  it("조용한 중간 구간은 직전 신뢰값을 이어쓴다(carried=true)", () => {
    const firstChzzk = bursts(CENTERS, 10, 0);
    const thirdChzzk = bursts(CENTERS, 10, 1_200_000);
    const chzzk = [...firstChzzk, ...thirdChzzk]; // 가운데 600초는 비어 있음
    const soop = [...shift(firstChzzk, 8_000), ...shift(thirdChzzk, 8_000)];

    const segments = estimateOffsetSegments(chzzk, soop);
    const carried = segments.filter((segment) => segment.carried);

    expect(carried.length).toBeGreaterThanOrEqual(1);
    expect(Math.abs(carried[0].offsetMs - -8_000)).toBeLessThanOrEqual(1_000);
  });

  it("선두 조용 구간(웜업)은 첫 신뢰값으로 backfill한다(carried=true)", () => {
    // 웜업: 선두 600초에는 증거 부족한 stray 메시지 몇 개만(추정 불가) → 첫 신뢰 구간으로 backfill
    const warmupChzzk = [1_000, 90_000];
    const secondChzzk = bursts(CENTERS, 10, 600_000);
    const chzzk = [...warmupChzzk, ...secondChzzk];
    const soop = [...shift(warmupChzzk, 8_000), ...shift(secondChzzk, 8_000)];

    const segments = estimateOffsetSegments(chzzk, soop);

    expect(segments[0].carried).toBe(true);
    expect(Math.abs(segments[0].offsetMs - -8_000)).toBeLessThanOrEqual(1_000);
  });
});
