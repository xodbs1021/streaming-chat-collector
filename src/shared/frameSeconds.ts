const DEFAULT_TOLERANCE_SEC = 15;

/** 정렬된 epochSec 배열에서 target 이하의 최근접 값을 찾는다 (허용 오차 초과 시 undefined) */
export function nearestFrameSecond(sortedSeconds: number[], target: number, toleranceSec = DEFAULT_TOLERANCE_SEC): number | undefined {
  let low = 0;
  let high = sortedSeconds.length - 1;
  let best: number | undefined;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (sortedSeconds[mid] <= target) {
      best = sortedSeconds[mid];
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  if (best === undefined || target - best > toleranceSec) {
    return undefined;
  }
  return best;
}
