import type { AnalyticsSummary, HighlightSummary, RecordingStatus, WindowComparisonSummary } from "../../../shared/types";

export const emptySummary: AnalyticsSummary = {
  generatedAt: 0,
  windowSec: 5,
  totalMessages: 0,
  uniqueChatters: 0,
  providerCounts: {},
  roleCounts: {},
  topChatters: [],
  topTerms: [],
  topEmotes: [],
  recentMessages: [],
  windows: []
};

export const initialRecordingStatus: RecordingStatus = {
  enabled: true,
  dataDir: "",
  message: "저장 대기 중"
};

export const emptyComparison: WindowComparisonSummary = {
  generatedAt: 0,
  items: []
};

export const emptyHighlightSummary: HighlightSummary = {
  generatedAt: 0,
  windowSec: 5,
  canSaveAnnotations: false,
  thresholds: {
    activeWindowMean: 0,
    p95: 0,
    p99: 0,
    max: 0,
    windowCount: 0,
    activeWindowCount: 0,
    candidateWindowCount: 0
  },
  candidates: [],
  annotations: {}
};
