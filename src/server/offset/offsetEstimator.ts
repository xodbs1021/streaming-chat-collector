import type { OffsetEstimatorParams, OffsetSegment } from "../../shared/types";

/**
 * 채팅 봉우리 cross-correlation으로 SOOP→치지직(anchor) offset을 추정하는 순수 모듈(I/O 없음).
 * 1초 bin·정규화 상관·±탐색으로 "SOOP을 얼마나 밀면 치지직 봉우리에 겹치나"를 찾는다.
 * 부호 규약(anchorTime = soopTime + offsetMs)은 src/shared/offset.ts와 동일 — 여기서 offsetMs를 만든다.
 * 구간당 계산량 ~N×lags(600×121≈7만 곱셈)라 FFT 불필요(YAGNI).
 */

export const DEFAULT_ESTIMATOR_PARAMS: OffsetEstimatorParams = {
  windowSec: 600,
  binSec: 1,
  searchSec: 60,
  reestimateSec: 60
};

/** 신뢰 판정 임계 — 이 값 미만이면 그 구간은 carry(추정치) 처리. 라이브 트래커도 공유. */
export const CONFIDENT_THRESHOLD = 0.1;
const MIN_CONFIDENCE = CONFIDENT_THRESHOLD;
/** 구간이 "조용하지 않다"고 보는 최소 이벤트 수(양 provider 각각). */
const MIN_EVENTS_PER_WINDOW = 5;
/** runner-up을 셀 때 피크 주변을 배제하는 가드(초) — 피크 자신의 어깨를 runner-up으로 오인하지 않도록. */
const RUNNER_UP_GUARD_SEC = 3;

export interface OffsetEstimate {
  offsetMs: number;
  /** 0~1 — 피크 강도(cosine) × runner-up 대비. */
  confidence: number;
}

/**
 * 한 구간의 chzzk·soop 타임스탬프로 최적 offset 1개를 계산한다.
 * 양쪽 다 충분한 이벤트가 있어야 하며(아니면 undefined), soop은 탐색폭만큼 넓혀 히스토그램을 만든다.
 */
export function estimateWindowOffset(
  chzzkTimes: number[],
  soopTimes: number[],
  windowStart: number,
  windowEnd: number,
  params: OffsetEstimatorParams
): OffsetEstimate | undefined {
  const binMs = params.binSec * 1000;
  const binCount = Math.max(1, Math.ceil((windowEnd - windowStart) / binMs));
  const searchBins = Math.max(1, Math.round(params.searchSec / params.binSec));
  const guardBins = Math.max(1, Math.round(RUNNER_UP_GUARD_SEC / params.binSec));

  const binOf = (time: number) => Math.floor((time - windowStart) / binMs);

  const chzzkBins = new Float64Array(binCount);
  let chzzkCount = 0;
  for (const time of chzzkTimes) {
    const bin = binOf(time);
    if (bin >= 0 && bin < binCount) {
      chzzkBins[bin] += 1;
      chzzkCount += 1;
    }
  }

  // soop은 탐색폭(±searchBins)만큼 넓게 담아, 어떤 lag에서도 전 구간 겹침이 유지되게 한다.
  const soopHist = new Map<number, number>();
  let soopCoreCount = 0;
  for (const time of soopTimes) {
    const bin = binOf(time);
    if (bin >= -searchBins && bin < binCount + searchBins) {
      soopHist.set(bin, (soopHist.get(bin) ?? 0) + 1);
      if (bin >= 0 && bin < binCount) {
        soopCoreCount += 1;
      }
    }
  }

  if (chzzkCount < MIN_EVENTS_PER_WINDOW || soopCoreCount < MIN_EVENTS_PER_WINDOW) {
    return undefined;
  }

  let normCSquared = 0;
  for (let bin = 0; bin < binCount; bin += 1) {
    normCSquared += chzzkBins[bin] * chzzkBins[bin];
  }
  if (normCSquared <= 0) {
    return undefined;
  }
  const normC = Math.sqrt(normCSquared);

  const correlations: number[] = [];
  let peak = -1;
  let peakLag = 0;
  for (let lag = -searchBins; lag <= searchBins; lag += 1) {
    let dot = 0;
    let energyS = 0;
    for (let bin = 0; bin < binCount; bin += 1) {
      const soopValue = soopHist.get(bin - lag) ?? 0;
      dot += chzzkBins[bin] * soopValue;
      energyS += soopValue * soopValue;
    }
    const correlation = energyS > 0 ? dot / (normC * Math.sqrt(energyS)) : 0;
    correlations.push(correlation);
    if (correlation > peak) {
      peak = correlation;
      peakLag = lag;
    }
  }

  let runnerUp = 0;
  for (let index = 0; index < correlations.length; index += 1) {
    const lag = index - searchBins;
    if (Math.abs(lag - peakLag) > guardBins) {
      runnerUp = Math.max(runnerUp, correlations[index]);
    }
  }

  const confidence = clamp01(peak * (peak - runnerUp));
  return { offsetMs: peakLag * binMs, confidence };
}

/**
 * 방송 전체 타임스탬프를 windowSec 타일로 나눠 구간별 offset을 계산한다.
 * 조용/저신뢰 구간은 직전 신뢰값을 이어쓰고(carried:true), 선두는 첫 신뢰값으로 backfill한다.
 * 신뢰 구간이 하나도 없으면 [](= 정렬 불가).
 */
export function estimateOffsetSegments(
  chzzkTimes: number[],
  soopTimes: number[],
  params: OffsetEstimatorParams = DEFAULT_ESTIMATOR_PARAMS
): OffsetSegment[] {
  if (chzzkTimes.length === 0 && soopTimes.length === 0) {
    return [];
  }
  // Math.min/max(...대량배열)는 ~12.5만 요소에서 스택/인자 한도 초과로 RangeError → finalize가 조용히
  // 실패한다(index.ts catch가 삼킴). 인기 방송일수록 메시지가 많으므로 반드시 단일 패스로 범위를 구한다.
  let start = Infinity;
  let end = -Infinity;
  for (const time of chzzkTimes) {
    if (time < start) start = time;
    if (time > end) end = time;
  }
  for (const time of soopTimes) {
    if (time < start) start = time;
    if (time > end) end = time;
  }
  const windowMs = params.windowSec * 1000;
  const tileCount = Math.max(1, Math.ceil((end - start + 1) / windowMs));

  const tiles = Array.from({ length: tileCount }, (_, index) => {
    const tileStart = start + index * windowMs;
    const tileEnd = tileStart + windowMs;
    const estimate = estimateWindowOffset(chzzkTimes, soopTimes, tileStart, tileEnd, params);
    const confident = estimate !== undefined && estimate.confidence >= MIN_CONFIDENCE;
    return { tileStart, tileEnd, estimate, confident };
  });

  const firstConfident = tiles.find((tile) => tile.confident)?.estimate;
  if (!firstConfident) {
    return [];
  }

  const raw: OffsetSegment[] = [];
  let lastConfidentOffset: number | undefined;
  for (const tile of tiles) {
    if (tile.confident && tile.estimate) {
      lastConfidentOffset = tile.estimate.offsetMs;
      raw.push({
        startAt: tile.tileStart,
        endAt: tile.tileEnd,
        offsetMs: tile.estimate.offsetMs,
        confidence: tile.estimate.confidence,
        carried: false
      });
    } else {
      raw.push({
        startAt: tile.tileStart,
        endAt: tile.tileEnd,
        offsetMs: lastConfidentOffset ?? firstConfident.offsetMs,
        confidence: tile.estimate?.confidence ?? 0,
        carried: true
      });
    }
  }

  return mergeAdjacent(raw);
}

/** offsetMs·carried가 동일한 인접 구간을 하나로 합쳐 목록을 콤팩트하게 만든다. */
function mergeAdjacent(segments: OffsetSegment[]): OffsetSegment[] {
  const merged: OffsetSegment[] = [];
  for (const segment of segments) {
    const previous = merged[merged.length - 1];
    if (previous && previous.offsetMs === segment.offsetMs && previous.carried === segment.carried) {
      merged[merged.length - 1] = {
        ...previous,
        endAt: segment.endAt,
        confidence: Math.max(previous.confidence, segment.confidence)
      };
    } else {
      merged.push(segment);
    }
  }
  return merged;
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}
