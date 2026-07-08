import type {
  AnalyticsRankItem,
  AnalyticsWindow,
  HighlightAnnotation,
  HighlightCandidate,
  HighlightCategory,
  HighlightLevel,
  HighlightSummary,
  HighlightThresholds
} from "../../../shared/types";
import { HIGHLIGHT_CATEGORIES, type TimelineSelection } from "./constants";

type WindowVisualLevel = HighlightLevel | "below";

export function buildManualCandidate({
  annotations,
  range,
  sessionId,
  thresholds,
  windows,
  windowSec
}: {
  annotations: HighlightSummary["annotations"];
  range: TimelineSelection;
  sessionId: string;
  thresholds: HighlightThresholds;
  windows: AnalyticsWindow[];
  windowSec: number;
}): HighlightCandidate {
  const selectedWindows = windows.filter((window) => window.windowStart < range.endAt && window.windowEnd > range.startAt);
  const peakCount = Math.max(0, ...selectedWindows.map((window) => window.messageCount));
  const totalMessages = selectedWindows.reduce((sum, window) => sum + window.messageCount, 0);
  const uniqueChatters = Math.max(0, ...selectedWindows.map((window) => window.uniqueChatters));
  const score = thresholds.activeWindowMean > 0 ? Math.round((peakCount / thresholds.activeWindowMean) * 10) / 10 : 0;
  const id = `${sessionId}-${windowSec}-${range.startAt}-${range.endAt}`;

  return {
    id,
    sessionId,
    windowSec,
    level: levelFromPeak(peakCount, thresholds),
    startAt: range.startAt,
    endAt: range.endAt,
    durationSec: Math.max(windowSec, Math.round((range.endAt - range.startAt) / 1000)),
    peakCount,
    totalMessages,
    uniqueChatters,
    score,
    topTerms: mergeRankItems(selectedWindows, "topTerms"),
    topEmotes: mergeRankItems(selectedWindows, "topEmotes"),
    annotation: annotations[id]
  };
}

function mergeRankItems(windows: AnalyticsWindow[], key: "topTerms" | "topEmotes") {
  const counts = new Map<string, AnalyticsRankItem>();
  for (const window of windows) {
    for (const item of window[key]) {
      const current = counts.get(item.label);
      counts.set(item.label, {
        id: item.id ?? current?.id,
        label: item.label,
        count: (current?.count ?? 0) + item.count
      });
    }
  }
  return Array.from(counts.values())
    .sort((a, b) => b.count - a.count)
    .slice(0, 5);
}

function levelFromPeak(peakCount: number, thresholds: HighlightThresholds): HighlightLevel {
  if (thresholds.p99 > 0 && peakCount >= thresholds.p99) {
    return "strong";
  }
  if (thresholds.p95 > 0 && peakCount >= thresholds.p95) {
    return "highlight";
  }
  return "review";
}

export function getSavedAnnotations(annotations: HighlightSummary["annotations"]) {
  return Object.values(annotations).sort((a, b) => {
    const left = getAnnotationRange(a)?.startAt ?? a.updatedAt;
    const right = getAnnotationRange(b)?.startAt ?? b.updatedAt;
    return left - right;
  });
}

export function getAnnotationRange(annotation: HighlightAnnotation) {
  if (annotation.startAt !== undefined && annotation.endAt !== undefined && annotation.windowSec !== undefined) {
    return {
      startAt: annotation.startAt,
      endAt: annotation.endAt,
      windowSec: annotation.windowSec
    };
  }

  const parts = annotation.candidateId.split("-");
  const endAt = Number(parts.at(-1));
  const startAt = Number(parts.at(-2));
  const windowSec = Number(parts.at(-3));
  if (!Number.isFinite(startAt) || !Number.isFinite(endAt) || !Number.isFinite(windowSec)) {
    return undefined;
  }
  return { startAt, endAt, windowSec };
}

export function categoryLabel(category: HighlightCategory) {
  return HIGHLIGHT_CATEGORIES.find((item) => item.value === category)?.label ?? "기타";
}

export function getWindowVisualLevel(window: AnalyticsWindow, thresholds: HighlightThresholds): WindowVisualLevel {
  if (thresholds.activeWindowMean <= 0 || window.messageCount < thresholds.activeWindowMean) {
    return "below";
  }
  if (window.messageCount >= thresholds.p99) {
    return "strong";
  }
  if (window.messageCount >= thresholds.p95) {
    return "highlight";
  }
  return "review";
}

export function formatWindowLevel(window: AnalyticsWindow, thresholds: HighlightThresholds) {
  const level = getWindowVisualLevel(window, thresholds);
  if (level === "below") {
    return "평균 이하";
  }
  const score = thresholds.activeWindowMean > 0 ? Math.round((window.messageCount / thresholds.activeWindowMean) * 10) / 10 : 0;
  return `${levelLabel(level)} · 평균 대비 ${score}x`;
}

export function levelLabel(level: HighlightLevel) {
  if (level === "strong") {
    return "강한 후보";
  }
  if (level === "highlight") {
    return "하이라이트";
  }
  return "검토";
}
