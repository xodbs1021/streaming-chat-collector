import { describe, expect, it } from "vitest";
import {
  CONFIDENT_THRESHOLD,
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

/** 같은 크기 봉우리 2개를 서로 다른 lag에 둬 피크≈runner-up(모호)로 만든다 — defined이나 저신뢰. */
function ambiguousWindow(startMs = 0): { chzzk: number[]; soop: number[] } {
  return {
    chzzk: bursts([100], 6, startMs),
    // soop 봉우리 2개(bin 108·150) — chzzk 봉우리를 어느 쪽에 맞춰도 상관이 같다.
    soop: [...bursts([108], 5, startMs), ...bursts([150], 5, startMs)]
  };
}

/** 결정론적 지터(LCG) — 현실적 신호 테스트에서 봉우리를 흩뿌린다. */
function jitter(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1_664_525 + 1_013_904_223) % 4_294_967_296;
    return state / 4_294_967_296; // 0~1
  };
}

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

  it("모호한 패턴(양쪽 ≥5 이벤트, 피크≈runner-up)은 defined이지만 저신뢰다", () => {
    const { chzzk, soop } = ambiguousWindow();
    const result = estimateWindowOffset(chzzk, soop, 0, 600_000, DEFAULT_ESTIMATOR_PARAMS);

    expect(result).toBeDefined(); // 조용하지 않음(양쪽 ≥5) — 기각은 신뢰도로만
    expect(result?.confidence ?? 1).toBeLessThan(CONFIDENT_THRESHOLD);
  });

  it("연속 노이즈 플로어 + 지터 있는 봉우리에서도 ±1초로 복원한다(현실적 신호)", () => {
    const rand = jitter(42);
    const chzzk: number[] = [];
    const soop: number[] = [];
    // 노이즈 플로어: 600초에 걸쳐 균일 배경 채팅.
    for (let i = 0; i < 180; i += 1) {
      const t = Math.floor(rand() * 600_000);
      chzzk.push(t);
      soop.push(Math.floor(rand() * 600_000) + 8_000);
    }
    // 지터 있는 부분 상관 봉우리(±400ms) — 완벽 정렬이 아니어도 잡아야 한다.
    for (const center of CENTERS) {
      for (let i = 0; i < 14; i += 1) {
        const base = center * 1000 + Math.floor((rand() - 0.5) * 800);
        chzzk.push(base);
        soop.push(base + 8_000 + Math.floor((rand() - 0.5) * 800));
      }
    }

    const result = estimateWindowOffset(chzzk, soop, 0, 600_000, DEFAULT_ESTIMATOR_PARAMS);
    expect(Math.abs((result?.offsetMs ?? 0) - -8_000)).toBeLessThanOrEqual(1_000);
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

  it("저신뢰(모호) 구간은 기각되어 직전 신뢰값을 carry한다(조용함과 별개 경로)", () => {
    const firstChzzk = bursts(CENTERS, 10, 0); // 신뢰 구간
    const ambiguous = ambiguousWindow(600_000); // 2번째 타일: 양쪽 이벤트는 있으나 모호 → 저신뢰
    const chzzk = [...firstChzzk, ...ambiguous.chzzk];
    const soop = [...shift(firstChzzk, 8_000), ...ambiguous.soop];

    const segments = estimateOffsetSegments(chzzk, soop);
    const carried = segments.filter((segment) => segment.carried);

    expect(carried.length).toBeGreaterThanOrEqual(1);
    expect(Math.abs(carried[0].offsetMs - -8_000)).toBeLessThanOrEqual(1_000);
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

  it("대량 배열(12.5만+)에서 스프레드 오버플로 없이 계산한다(RangeError 회귀)", () => {
    // Math.min(...all) 회귀 — 이 크기에서 옛 코드는 RangeError를 던졌다.
    const chzzk: number[] = [];
    for (let i = 0; i < 150_000; i += 1) {
      chzzk.push((i % 600) * 1000 + ((i * 37) % 1000));
    }
    const soop = chzzk.map((time) => time + 8_000);

    expect(() => estimateOffsetSegments(chzzk, soop)).not.toThrow();
    const segments = estimateOffsetSegments(chzzk, soop);
    expect(Array.isArray(segments)).toBe(true);
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
