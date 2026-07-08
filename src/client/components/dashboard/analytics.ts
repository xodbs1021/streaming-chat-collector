import type { AnalyticsSummary, AnalyticsWindow } from "../../../shared/types";

export function mergePartialSummary(current: AnalyticsSummary, incoming: AnalyticsSummary): AnalyticsSummary {
  const { partialWindows: _partial, ...rest } = incoming;
  if (current.windowSec !== incoming.windowSec) {
    // 윈도우 크기 전환 직후 — 전체 윈도우는 REST 재조회가 채우므로 병합하지 않음
    return current;
  }
  if (current.windows.length === 0) {
    return { ...rest };
  }
  const byStart = new Map(current.windows.map((window) => [window.windowStart, window]));
  for (const window of incoming.windows) {
    const previous = byStart.get(window.windowStart);
    byStart.set(
      window.windowStart,
      previous?.keywordCounts && !window.keywordCounts ? { ...window, keywordCounts: previous.keywordCounts } : window
    );
  }
  const windows = Array.from(byStart.values()).sort((left, right) => left.windowStart - right.windowStart);
  return { ...rest, windows };
}

export function maxWindow(windows: AnalyticsWindow[]) {
  return Math.max(0, ...windows.map((window) => window.messageCount));
}

export function avgMessageLength(windows: AnalyticsWindow[]) {
  const totals = windows.reduce(
    (acc, window) => {
      acc.sum += window.avgLength * window.messageCount;
      acc.count += window.messageCount;
      return acc;
    },
    { sum: 0, count: 0 }
  );
  return totals.count ? Math.round((totals.sum / totals.count) * 10) / 10 : 0;
}
