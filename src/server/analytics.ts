import type {
  AnalyticsRankItem,
  AnalyticsSummary,
  AnalyticsWindow,
  ChatProvider,
  ChatRecord,
  ChatRole,
  HighlightAnnotationMap,
  HighlightCandidate,
  HighlightLevel,
  HighlightSummary,
  HighlightThresholds,
  RecordingSession,
  ViewerCountSample,
  WindowComparisonSummary
} from "../shared/types";
import { countKeywords, tokenize } from "./analytics/text";
import { countUnique, percentile, rankEmotes, rankTerms, round } from "./analytics/stats";
import {
  type WindowAgg,
  addToGlobalAgg,
  addToWindowAgg,
  averageViewerCount,
  createGlobalAgg,
  createWindowAgg,
  finalizeGlobalTops,
  finalizeWindow,
  latestViewerCount,
  participationRate
} from "./analytics/metrics";

const DEFAULT_WINDOW_SEC = 5;
const VIEWER_SAMPLE_LIMIT = 20_000;
const MAX_LIVE_RECORDS = 200_000;
const RECENT_MESSAGE_LIMIT = 30;

export function summarizeChatRecords(
  records: ChatRecord[],
  windowSec = DEFAULT_WINDOW_SEC,
  session?: RecordingSession,
  viewerSamples: ViewerCountSample[] = [],
  keywords: string[] = [],
  now = Date.now()
): AnalyticsSummary {
  const safeWindowSec = Math.max(1, Math.round(windowSec));
  const windowMs = safeWindowSec * 1000;
  const sorted = [...records].sort((left, right) => left.timestamp - right.timestamp);
  const global = createGlobalAgg();
  const windows = new Map<number, WindowAgg>();

  for (const record of sorted) {
    const tokens = tokenize(record.content);
    addToGlobalAgg(global, record, tokens);
    const windowStart = Math.floor(record.timestamp / windowMs) * windowMs;
    let agg = windows.get(windowStart);
    if (!agg) {
      agg = createWindowAgg(windowStart);
      windows.set(windowStart, agg);
    }
    addToWindowAgg(agg, record, tokens);
  }

  const analyticsWindows: AnalyticsWindow[] = Array.from(windows.values())
    .sort((left, right) => left.windowStart - right.windowStart)
    .map((agg) => {
      const windowViewerCount = latestViewerCount(viewerSamples, agg.windowStart + windowMs);
      const window = finalizeWindow(agg, windowMs, windowViewerCount);
      const keywordCounts = countKeywords(agg.records, keywords);
      return keywordCounts ? { ...window, keywordCounts } : window;
    });

  const viewerCount = latestViewerCount(viewerSamples, now);
  const tops = finalizeGlobalTops(global);

  return {
    viewerCount,
    participationRate: participationRate(global.chatterLastSeen, viewerSamples, viewerCount, now),
    generatedAt: now,
    windowSec: safeWindowSec,
    totalMessages: sorted.length,
    uniqueChatters: global.uniqueNicknames.size,
    startedAt: session?.startedAt ?? sorted[0]?.timestamp,
    endedAt: session?.endedAt ?? sorted.at(-1)?.timestamp,
    session,
    providerCounts: { ...global.providerCounts },
    roleCounts: { ...global.roleCounts },
    topChatters: tops.topChatters,
    topTerms: tops.topTerms,
    topEmotes: tops.topEmotes,
    recentMessages: sorted.slice(-RECENT_MESSAGE_LIMIT).reverse(),
    windows: analyticsWindows
  };
}

export function summarizeHighlightCandidates(
  records: ChatRecord[],
  windowSec = DEFAULT_WINDOW_SEC,
  session?: RecordingSession,
  annotations: HighlightAnnotationMap = {},
  canSaveAnnotations = Boolean(session)
): HighlightSummary {
  const safeWindowSec = Math.max(1, Math.round(windowSec));
  const windowMs = safeWindowSec * 1000;
  const sorted = [...records].sort((left, right) => left.timestamp - right.timestamp);
  const baseSessionId = session?.sessionId ?? "live";

  if (sorted.length === 0) {
    return {
      generatedAt: Date.now(),
      windowSec: safeWindowSec,
      session,
      canSaveAnnotations,
      thresholds: emptyThresholds(),
      candidates: [],
      annotations
    };
  }

  const buckets = new Map<number, WindowAgg>();
  for (const record of sorted) {
    const windowStart = Math.floor(record.timestamp / windowMs) * windowMs;
    let agg = buckets.get(windowStart);
    if (!agg) {
      agg = createWindowAgg(windowStart);
      buckets.set(windowStart, agg);
    }
    addToWindowAgg(agg, record, tokenize(record.content));
  }

  const windows = Array.from(buckets.values())
    .sort((left, right) => left.windowStart - right.windowStart)
    .map((agg) => finalizeWindow(agg, windowMs, undefined));
  const counts = windows.map((window) => window.messageCount).filter((count) => count > 0);
  const activeWindowMean = counts.length ? round(counts.reduce((sum, count) => sum + count, 0) / counts.length) : 0;
  const p95 = percentile(counts, 0.95);
  const p99 = percentile(counts, 0.99);
  const max = Math.max(0, ...counts);
  const candidateWindows = windows
    .map((window) => ({ window, level: classifyWindow(window.messageCount, activeWindowMean, p95, p99) }))
    .filter((item): item is { window: AnalyticsWindow; level: HighlightLevel } => Boolean(item.level));
  const thresholds: HighlightThresholds = {
    activeWindowMean,
    p95,
    p99,
    max,
    windowCount: windows.length,
    activeWindowCount: counts.length,
    candidateWindowCount: candidateWindows.length
  };
  const groups = mergeCandidateWindows(candidateWindows, windowMs);
  const candidates = groups.map((group) => buildCandidate(group, sorted, baseSessionId, safeWindowSec, activeWindowMean, annotations));

  return {
    generatedAt: Date.now(),
    windowSec: safeWindowSec,
    session,
    canSaveAnnotations,
    thresholds,
    candidates,
    annotations
  };
}

export function summarizeWindowComparison(
  records: ChatRecord[],
  windowOptions = [1, 3, 5, 10],
  session?: RecordingSession
): WindowComparisonSummary {
  return {
    generatedAt: Date.now(),
    session,
    items: windowOptions.map((windowSec) => {
      const summary = summarizeHighlightCandidates(records, windowSec, session);
      return {
        windowSec: summary.windowSec,
        totalMessages: records.length,
        windowCount: summary.thresholds.windowCount,
        activeWindowMean: summary.thresholds.activeWindowMean,
        p95: summary.thresholds.p95,
        p99: summary.thresholds.p99,
        max: summary.thresholds.max,
        candidateWindowCount: summary.thresholds.candidateWindowCount,
        reviewCount: summary.candidates.filter((candidate) => candidate.level === "review").length,
        highlightCount: summary.candidates.filter((candidate) => candidate.level === "highlight").length,
        strongCount: summary.candidates.filter((candidate) => candidate.level === "strong").length,
        topScore: Math.max(0, ...summary.candidates.map((candidate) => candidate.score))
      };
    })
  };
}

const LIVE_TRIM_CHUNK = 10_000;
const MAX_BUCKET_SETS = 6;
const GLOBAL_TOPS_CACHE_MS = 1_000;

interface LiveBucketSet {
  windowSec: number;
  windowMs: number;
  buckets: Map<number, WindowAgg>;
  materialized: Map<number, AnalyticsWindow>;
  dirtyStarts: Set<number>;
}

export interface LiveSummaryOptions {
  /** limit the windows array to the most recent N windows and mark the summary as partial */
  recentWindowLimit?: number;
}

export class LiveAnalytics {
  private records: ChatRecord[] = [];
  private viewerSamples: ViewerCountSample[] = [];
  private global = createGlobalAgg();
  private bucketSets = new Map<number, LiveBucketSet>();
  private globalTopsCache:
    | { at: number; topChatters: AnalyticsRankItem[]; topTerms: AnalyticsRankItem[]; topEmotes: AnalyticsRankItem[] }
    | undefined;

  // clock 주입으로 addViewerSample 타임스탬프·참여율 cutoff·tops 캐시·generatedAt·전역 viewerCount를
  // 결정론적으로 대조할 수 있게 한다(기본값 Date.now로 운영 동작 불변).
  constructor(private clock: () => number = Date.now) {}

  append(record: ChatRecord) {
    this.insertSorted(record);
    const tokens = tokenize(record.content);
    addToGlobalAgg(this.global, record, tokens);
    for (const set of this.bucketSets.values()) {
      applyToBucketSet(set, record, tokens);
    }
    if (this.records.length > MAX_LIVE_RECORDS + LIVE_TRIM_CHUNK) {
      this.records = this.records.slice(-MAX_LIVE_RECORDS);
      this.rebuildAggregates();
    }
  }

  addRecord(record: ChatRecord, session?: RecordingSession, windowSec = DEFAULT_WINDOW_SEC) {
    this.append(record);
    return this.getSummary(session, windowSec);
  }

  addViewerSample(provider: ViewerCountSample["provider"], count: number) {
    if (!Number.isFinite(count) || count < 0) {
      return;
    }
    const sample: ViewerCountSample = { provider, timestamp: this.clock(), count: Math.round(count) };
    this.viewerSamples.push(sample);
    if (this.viewerSamples.length > VIEWER_SAMPLE_LIMIT) {
      this.viewerSamples = this.viewerSamples.slice(-VIEWER_SAMPLE_LIMIT);
    }
    for (const set of this.bucketSets.values()) {
      const windowStart = Math.floor(sample.timestamp / set.windowMs) * set.windowMs;
      if (set.buckets.has(windowStart)) {
        set.dirtyStarts.add(windowStart);
      }
    }
  }

  reset() {
    this.records = [];
    this.global = createGlobalAgg();
    this.bucketSets.clear();
    this.globalTopsCache = undefined;
  }

  getSummary(
    session?: RecordingSession,
    windowSec = DEFAULT_WINDOW_SEC,
    keywords: string[] = [],
    options: LiveSummaryOptions = {}
  ): AnalyticsSummary {
    const safeWindowSec = Math.max(1, Math.round(windowSec));
    const set = this.ensureBucketSet(safeWindowSec);
    this.materializeDirty(set);
    const starts = Array.from(set.buckets.keys()).sort((left, right) => left - right);
    const limit = options.recentWindowLimit;
    const isPartial = limit !== undefined && limit > 0 && starts.length > limit;
    const selectedStarts = isPartial ? starts.slice(-limit) : starts;
    const windows = selectedStarts.map((windowStart) => {
      const materialized = set.materialized.get(windowStart) as AnalyticsWindow;
      if (keywords.length === 0) {
        return materialized;
      }
      const bucket = set.buckets.get(windowStart);
      const keywordCounts = bucket ? countKeywords(bucket.records, keywords) : undefined;
      return keywordCounts ? { ...materialized, keywordCounts } : materialized;
    });
    const viewerCount = latestViewerCount(this.viewerSamples, this.clock());

    return {
      viewerCount,
      participationRate: this.computeParticipation(viewerCount),
      generatedAt: this.clock(),
      windowSec: safeWindowSec,
      totalMessages: this.records.length,
      uniqueChatters: this.global.uniqueNicknames.size,
      startedAt: session?.startedAt ?? this.records[0]?.timestamp,
      endedAt: session?.endedAt ?? this.records.at(-1)?.timestamp,
      session,
      providerCounts: { ...this.global.providerCounts },
      roleCounts: { ...this.global.roleCounts },
      ...this.getGlobalTops(),
      // 0.1초 주기 소켓 푸시(partial)에는 최근 메시지를 싣지 않아 페이로드를 줄임
      recentMessages: isPartial ? [] : this.records.slice(-RECENT_MESSAGE_LIMIT).reverse(),
      windows,
      ...(isPartial ? { partialWindows: true } : {})
    };
  }

  getRecords() {
    return [...this.records];
  }

  private insertSorted(record: ChatRecord) {
    const last = this.records.at(-1);
    if (!last || record.timestamp >= last.timestamp) {
      this.records.push(record);
      return;
    }
    let index = this.records.length - 1;
    while (index > 0 && this.records[index - 1].timestamp > record.timestamp) {
      index -= 1;
    }
    this.records.splice(index, 0, record);
  }

  private ensureBucketSet(windowSec: number): LiveBucketSet {
    const existing = this.bucketSets.get(windowSec);
    if (existing) {
      return existing;
    }
    if (this.bucketSets.size >= MAX_BUCKET_SETS) {
      for (const key of this.bucketSets.keys()) {
        if (key !== DEFAULT_WINDOW_SEC) {
          this.bucketSets.delete(key);
          break;
        }
      }
    }
    const set: LiveBucketSet = {
      windowSec,
      windowMs: windowSec * 1000,
      buckets: new Map(),
      materialized: new Map(),
      dirtyStarts: new Set()
    };
    for (const record of this.records) {
      applyToBucketSet(set, record, tokenize(record.content));
    }
    this.bucketSets.set(windowSec, set);
    return set;
  }

  private materializeDirty(set: LiveBucketSet) {
    for (const windowStart of set.dirtyStarts) {
      const agg = set.buckets.get(windowStart);
      if (!agg) {
        continue;
      }
      const viewerCount = latestViewerCount(this.viewerSamples, windowStart + set.windowMs);
      set.materialized.set(windowStart, finalizeWindow(agg, set.windowMs, viewerCount));
    }
    set.dirtyStarts.clear();
  }

  /** 전역 상위 랭킹은 0.1초 emit마다 큰 Map을 정렬하지 않도록 1초 캐시 */
  private getGlobalTops() {
    const now = this.clock();
    if (!this.globalTopsCache || now - this.globalTopsCache.at >= GLOBAL_TOPS_CACHE_MS) {
      this.globalTopsCache = { at: now, ...finalizeGlobalTops(this.global) };
    }
    const { topChatters, topTerms, topEmotes } = this.globalTopsCache;
    return { topChatters, topTerms, topEmotes };
  }

  private computeParticipation(fallbackViewerCount: number | undefined) {
    return participationRate(this.global.chatterLastSeen, this.viewerSamples, fallbackViewerCount, this.clock());
  }

  private rebuildAggregates() {
    this.global = createGlobalAgg();
    const sets = Array.from(this.bucketSets.values());
    for (const set of sets) {
      set.buckets.clear();
      set.materialized.clear();
      set.dirtyStarts.clear();
    }
    for (const record of this.records) {
      const tokens = tokenize(record.content);
      addToGlobalAgg(this.global, record, tokens);
      for (const set of sets) {
        applyToBucketSet(set, record, tokens);
      }
    }
  }
}

function applyToBucketSet(set: LiveBucketSet, record: ChatRecord, tokens: string[]) {
  const windowStart = Math.floor(record.timestamp / set.windowMs) * set.windowMs;
  let agg = set.buckets.get(windowStart);
  if (!agg) {
    agg = createWindowAgg(windowStart);
    set.buckets.set(windowStart, agg);
  }
  addToWindowAgg(agg, record, tokens);
  set.dirtyStarts.add(windowStart);
}

interface CandidateWindow {
  window: AnalyticsWindow;
  level: HighlightLevel;
}

function emptyThresholds(): HighlightThresholds {
  return {
    activeWindowMean: 0,
    p95: 0,
    p99: 0,
    max: 0,
    windowCount: 0,
    activeWindowCount: 0,
    candidateWindowCount: 0
  };
}

function classifyWindow(count: number, activeWindowMean: number, p95: number, p99: number): HighlightLevel | undefined {
  if (activeWindowMean <= 0 || count < activeWindowMean) {
    return undefined;
  }
  if (count >= p99) {
    return "strong";
  }
  if (count >= p95) {
    return "highlight";
  }
  return "review";
}

function mergeCandidateWindows(windows: CandidateWindow[], windowMs: number) {
  const groups: CandidateWindow[][] = [];
  for (const item of windows) {
    const previous = groups.at(-1);
    const previousEnd = previous?.at(-1)?.window.windowEnd;
    if (previous && previousEnd !== undefined && item.window.windowStart - previousEnd <= windowMs) {
      previous.push(item);
    } else {
      groups.push([item]);
    }
  }
  return groups;
}

function buildCandidate(
  group: CandidateWindow[],
  records: ChatRecord[],
  sessionId: string,
  windowSec: number,
  activeWindowMean: number,
  annotations: HighlightAnnotationMap
): HighlightCandidate {
  const startAt = group[0].window.windowStart;
  const endAt = group.at(-1)?.window.windowEnd ?? startAt;
  const groupRecords = records.filter((record) => record.timestamp >= startAt && record.timestamp < endAt);
  const peakCount = Math.max(0, ...group.map((item) => item.window.messageCount));
  const id = `${sessionId}-${windowSec}-${startAt}-${endAt}`;
  return {
    id,
    sessionId,
    windowSec,
    level: strongestLevel(group.map((item) => item.level)),
    startAt,
    endAt,
    durationSec: Math.max(0, Math.round((endAt - startAt) / 1000)),
    peakCount,
    totalMessages: groupRecords.length,
    uniqueChatters: countUnique(groupRecords.map((record) => record.nickname)),
    score: activeWindowMean > 0 ? round(peakCount / activeWindowMean) : 0,
    topTerms: rankTerms(groupRecords, 5),
    topEmotes: rankEmotes(groupRecords, 5),
    annotation: annotations[id]
  };
}

function strongestLevel(levels: HighlightLevel[]) {
  const score: Record<HighlightLevel, number> = { review: 1, highlight: 2, strong: 3 };
  return levels.reduce<HighlightLevel>((best, level) => (score[level] > score[best] ? level : best), "review");
}

/** 방송 전체 기간 참여율 — 5분 롤링(현재 분위기)과 달리 세션 종료 후 최종 지표로 내보내기용 */
export function computeOverallParticipationRate(records: ChatRecord[], viewerSamples: ViewerCountSample[]): number | undefined {
  const averageViewers = averageViewerCount(viewerSamples);
  if (averageViewers === undefined || averageViewers <= 0) {
    return undefined;
  }
  const uniqueChatters = countUnique(records.map((record) => record.nickname));
  return Math.round((uniqueChatters / averageViewers) * 1000) / 1000;
}

export type CountByProvider = Partial<Record<ChatProvider, number>>;
export type CountByRole = Partial<Record<ChatRole, number>>;
