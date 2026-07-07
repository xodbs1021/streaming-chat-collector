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

const DEFAULT_WINDOW_SEC = 5;
const VIEWER_SAMPLE_MAX_AGE_MS = 150_000;
const VIEWER_SAMPLE_LIMIT = 20_000;
const PARTICIPATION_LOOKBACK_MS = 300_000;
const MAX_LIVE_RECORDS = 200_000;
const MAX_KEYWORDS = 8;
const RECENT_MESSAGE_LIMIT = 30;
const TOP_LIMIT = 8;
const STOPWORDS = new Set([
  "그리고",
  "그래서",
  "근데",
  "그냥",
  "오늘",
  "진짜",
  "너무",
  "ㅋㅋ",
  "ㅎㅎ",
  "the",
  "and",
  "for",
  "you",
  "that",
  "this",
  "with",
  "are",
  "was"
]);

export function summarizeChatRecords(
  records: ChatRecord[],
  windowSec = DEFAULT_WINDOW_SEC,
  session?: RecordingSession,
  viewerSamples: ViewerCountSample[] = [],
  keywords: string[] = []
): AnalyticsSummary {
  const safeWindowSec = Math.max(1, Math.round(windowSec));
  const windowMs = safeWindowSec * 1000;
  const sorted = [...records].sort((left, right) => left.timestamp - right.timestamp);
  const windows = new Map<number, ChatRecord[]>();

  for (const record of sorted) {
    const windowStart = Math.floor(record.timestamp / windowMs) * windowMs;
    const bucket = windows.get(windowStart) ?? [];
    bucket.push(record);
    windows.set(windowStart, bucket);
  }

  const analyticsWindows: AnalyticsWindow[] = Array.from(windows.entries())
    .sort(([left], [right]) => left - right)
    .map(([windowStart, windowRecords]) => {
      const window = buildWindow(windowStart, windowMs, windowRecords);
      const windowViewerCount = latestViewerCount(viewerSamples, window.windowEnd);
      const keywordCounts = countKeywords(windowRecords, keywords);
      return {
        ...window,
        ...(windowViewerCount === undefined ? {} : { viewerCount: windowViewerCount }),
        ...(keywordCounts ? { keywordCounts } : {})
      };
    });

  const viewerCount = latestViewerCount(viewerSamples, Date.now());

  return {
    viewerCount,
    participationRate: computeParticipationRate(sorted, viewerSamples, viewerCount),
    generatedAt: Date.now(),
    windowSec: safeWindowSec,
    totalMessages: sorted.length,
    uniqueChatters: countUnique(sorted.map((record) => record.nickname)),
    startedAt: session?.startedAt ?? sorted[0]?.timestamp,
    endedAt: session?.endedAt ?? sorted.at(-1)?.timestamp,
    session,
    providerCounts: countBy(sorted, (record) => record.provider),
    roleCounts: countBy(sorted, (record) => record.role),
    topChatters: rankBy(sorted, (record) => record.nickname),
    topTerms: rankTerms(sorted),
    topEmotes: rankEmotes(sorted),
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

  const buckets = new Map<number, ChatRecord[]>();
  for (const record of sorted) {
    const windowStart = Math.floor(record.timestamp / windowMs) * windowMs;
    const bucket = buckets.get(windowStart) ?? [];
    bucket.push(record);
    buckets.set(windowStart, bucket);
  }

  const windows = Array.from(buckets.entries())
    .sort(([left], [right]) => left - right)
    .map(([windowStart, windowRecords]) => buildWindow(windowStart, windowMs, windowRecords));
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

interface LiveWindowAgg {
  windowStart: number;
  records: ChatRecord[];
  uniqueNicknames: Set<string>;
  chatterCounts: Map<string, number>;
  termCounts: Map<string, number>;
  emoteCounts: Map<string, number>;
  providerCounts: Partial<Record<ChatProvider, number>>;
  roleCounts: Partial<Record<ChatRole, number>>;
  lengthSum: number;
  maxLength: number;
}

interface LiveBucketSet {
  windowSec: number;
  windowMs: number;
  buckets: Map<number, LiveWindowAgg>;
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
  private uniqueNicknames = new Set<string>();
  private chatterCounts = new Map<string, number>();
  private termCounts = new Map<string, number>();
  private emoteCounts = new Map<string, number>();
  private providerCounts: Partial<Record<ChatProvider, number>> = {};
  private roleCounts: Partial<Record<ChatRole, number>> = {};
  private chatterLastSeen = new Map<string, number>();
  private bucketSets = new Map<number, LiveBucketSet>();
  private globalTopsCache:
    | { at: number; topChatters: AnalyticsRankItem[]; topTerms: AnalyticsRankItem[]; topEmotes: AnalyticsRankItem[] }
    | undefined;

  append(record: ChatRecord) {
    this.insertSorted(record);
    const tokens = tokenize(record.content);
    this.applyGlobal(record, tokens);
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
    const sample: ViewerCountSample = { provider, timestamp: Date.now(), count: Math.round(count) };
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
    this.uniqueNicknames.clear();
    this.chatterCounts.clear();
    this.termCounts.clear();
    this.emoteCounts.clear();
    this.providerCounts = {};
    this.roleCounts = {};
    this.chatterLastSeen.clear();
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
    const viewerCount = latestViewerCount(this.viewerSamples, Date.now());

    return {
      viewerCount,
      participationRate: this.computeParticipation(viewerCount),
      generatedAt: Date.now(),
      windowSec: safeWindowSec,
      totalMessages: this.records.length,
      uniqueChatters: this.uniqueNicknames.size,
      startedAt: session?.startedAt ?? this.records[0]?.timestamp,
      endedAt: session?.endedAt ?? this.records.at(-1)?.timestamp,
      session,
      providerCounts: { ...this.providerCounts },
      roleCounts: { ...this.roleCounts },
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

  private applyGlobal(record: ChatRecord, tokens: string[]) {
    if (record.nickname) {
      this.uniqueNicknames.add(record.nickname);
      const lastSeen = this.chatterLastSeen.get(record.nickname) ?? 0;
      if (record.timestamp > lastSeen) {
        this.chatterLastSeen.set(record.nickname, record.timestamp);
      }
    }
    const trimmedNickname = record.nickname.trim();
    if (trimmedNickname) {
      this.chatterCounts.set(trimmedNickname, (this.chatterCounts.get(trimmedNickname) ?? 0) + 1);
    }
    this.providerCounts[record.provider] = (this.providerCounts[record.provider] ?? 0) + 1;
    this.roleCounts[record.role] = (this.roleCounts[record.role] ?? 0) + 1;
    for (const term of tokens) {
      this.termCounts.set(term, (this.termCounts.get(term) ?? 0) + 1);
    }
    for (const emote of record.emotes) {
      const label = emote.token || emote.id;
      if (label) {
        this.emoteCounts.set(label, (this.emoteCounts.get(label) ?? 0) + 1);
      }
    }
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
      const windowEnd = windowStart + set.windowMs;
      const viewerCount = latestViewerCount(this.viewerSamples, windowEnd);
      set.materialized.set(windowStart, {
        windowStart,
        windowEnd,
        messageCount: agg.records.length,
        uniqueChatters: agg.uniqueNicknames.size,
        avgLength: agg.records.length ? round(agg.lengthSum / agg.records.length) : 0,
        maxLength: agg.maxLength,
        providerCounts: { ...agg.providerCounts },
        roleCounts: { ...agg.roleCounts },
        topChatters: mapToRank(agg.chatterCounts, 5),
        topTerms: mapToRank(agg.termCounts, 5),
        topEmotes: mapToRank(agg.emoteCounts, 5),
        ...(viewerCount === undefined ? {} : { viewerCount })
      });
    }
    set.dirtyStarts.clear();
  }

  /** 전역 상위 랭킹은 0.1초 emit마다 큰 Map을 정렬하지 않도록 1초 캐시 */
  private getGlobalTops() {
    const now = Date.now();
    if (!this.globalTopsCache || now - this.globalTopsCache.at >= GLOBAL_TOPS_CACHE_MS) {
      this.globalTopsCache = {
        at: now,
        topChatters: mapToRank(this.chatterCounts, TOP_LIMIT),
        topTerms: mapToRank(this.termCounts, TOP_LIMIT),
        topEmotes: mapToRank(this.emoteCounts, TOP_LIMIT)
      };
    }
    const { topChatters, topTerms, topEmotes } = this.globalTopsCache;
    return { topChatters, topTerms, topEmotes };
  }

  private computeParticipation(fallbackViewerCount: number | undefined) {
    const cutoff = Date.now() - PARTICIPATION_LOOKBACK_MS;
    // 분자(기간 내 채팅러)와 분모(같은 기간의 평균 시청자)를 동일 구간으로 맞춤
    const averageViewers = averageViewerCount(this.viewerSamples, cutoff) ?? fallbackViewerCount;
    if (averageViewers === undefined || averageViewers <= 0) {
      return undefined;
    }
    let recentChatters = 0;
    for (const lastSeen of this.chatterLastSeen.values()) {
      if (lastSeen >= cutoff) {
        recentChatters += 1;
      }
    }
    return Math.round((recentChatters / averageViewers) * 1000) / 1000;
  }

  private rebuildAggregates() {
    this.uniqueNicknames.clear();
    this.chatterCounts.clear();
    this.termCounts.clear();
    this.emoteCounts.clear();
    this.providerCounts = {};
    this.roleCounts = {};
    this.chatterLastSeen.clear();
    const sets = Array.from(this.bucketSets.values());
    for (const set of sets) {
      set.buckets.clear();
      set.materialized.clear();
      set.dirtyStarts.clear();
    }
    for (const record of this.records) {
      const tokens = tokenize(record.content);
      this.applyGlobal(record, tokens);
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
    agg = {
      windowStart,
      records: [],
      uniqueNicknames: new Set(),
      chatterCounts: new Map(),
      termCounts: new Map(),
      emoteCounts: new Map(),
      providerCounts: {},
      roleCounts: {},
      lengthSum: 0,
      maxLength: 0
    };
    set.buckets.set(windowStart, agg);
  }
  agg.records.push(record);
  if (record.nickname) {
    agg.uniqueNicknames.add(record.nickname);
  }
  const trimmedNickname = record.nickname.trim();
  if (trimmedNickname) {
    agg.chatterCounts.set(trimmedNickname, (agg.chatterCounts.get(trimmedNickname) ?? 0) + 1);
  }
  agg.providerCounts[record.provider] = (agg.providerCounts[record.provider] ?? 0) + 1;
  agg.roleCounts[record.role] = (agg.roleCounts[record.role] ?? 0) + 1;
  for (const term of tokens) {
    agg.termCounts.set(term, (agg.termCounts.get(term) ?? 0) + 1);
  }
  for (const emote of record.emotes) {
    const label = emote.token || emote.id;
    if (label) {
      agg.emoteCounts.set(label, (agg.emoteCounts.get(label) ?? 0) + 1);
    }
  }
  agg.lengthSum += record.content.length;
  agg.maxLength = Math.max(agg.maxLength, record.content.length);
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

function buildWindow(windowStart: number, windowMs: number, records: ChatRecord[]): AnalyticsWindow {
  const lengths = records.map((record) => record.content.length);
  return {
    windowStart,
    windowEnd: windowStart + windowMs,
    messageCount: records.length,
    uniqueChatters: countUnique(records.map((record) => record.nickname)),
    avgLength: lengths.length ? round(lengths.reduce((sum, length) => sum + length, 0) / lengths.length) : 0,
    maxLength: lengths.length ? Math.max(...lengths) : 0,
    providerCounts: countBy(records, (record) => record.provider),
    roleCounts: countBy(records, (record) => record.role),
    topChatters: rankBy(records, (record) => record.nickname, 5),
    topTerms: rankTerms(records, 5),
    topEmotes: rankEmotes(records, 5)
  };
}

function countKeywords(records: ChatRecord[], keywords: string[]): Record<string, number> | undefined {
  const normalized = keywords
    .map((keyword) => keyword.trim().toLowerCase())
    .filter(Boolean)
    .slice(0, MAX_KEYWORDS);
  if (normalized.length === 0) {
    return undefined;
  }
  const counts: Record<string, number> = {};
  for (const keyword of normalized) {
    counts[keyword] = 0;
  }
  for (const record of records) {
    const content = record.content.toLowerCase();
    for (const keyword of normalized) {
      if (content.includes(keyword)) {
        counts[keyword] += 1;
      }
    }
  }
  return counts;
}

function latestViewerCount(samples: ViewerCountSample[], at: number, maxAgeMs = VIEWER_SAMPLE_MAX_AGE_MS) {
  if (samples.length === 0) {
    return undefined;
  }
  const latestByProvider = new Map<ViewerCountSample["provider"], number>();
  for (const sample of samples) {
    if (sample.timestamp > at || at - sample.timestamp > maxAgeMs) {
      continue;
    }
    latestByProvider.set(sample.provider, sample.count);
  }
  if (latestByProvider.size === 0) {
    return undefined;
  }
  let total = 0;
  for (const count of latestByProvider.values()) {
    total += count;
  }
  return total;
}

function computeParticipationRate(
  sorted: ChatRecord[],
  viewerSamples: ViewerCountSample[],
  fallbackViewerCount: number | undefined
) {
  const cutoff = Date.now() - PARTICIPATION_LOOKBACK_MS;
  // 분자(기간 내 채팅러)와 분모(같은 기간의 평균 시청자)를 동일 구간으로 맞춤
  const averageViewers = averageViewerCount(viewerSamples, cutoff) ?? fallbackViewerCount;
  if (averageViewers === undefined || averageViewers <= 0) {
    return undefined;
  }
  const recentChatters = countUnique(sorted.filter((record) => record.timestamp >= cutoff).map((record) => record.nickname));
  return Math.round((recentChatters / averageViewers) * 1000) / 1000;
}

function averageViewerCount(samples: ViewerCountSample[], cutoff?: number) {
  const perProvider = new Map<ViewerCountSample["provider"], { sum: number; count: number }>();
  for (const sample of samples) {
    if (cutoff !== undefined && sample.timestamp < cutoff) {
      continue;
    }
    const agg = perProvider.get(sample.provider) ?? { sum: 0, count: 0 };
    agg.sum += sample.count;
    agg.count += 1;
    perProvider.set(sample.provider, agg);
  }
  if (perProvider.size === 0) {
    return undefined;
  }
  let total = 0;
  for (const agg of perProvider.values()) {
    total += agg.sum / agg.count;
  }
  return total;
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

function countUnique(values: string[]) {
  return new Set(values.filter(Boolean)).size;
}

function countBy<T extends string>(records: ChatRecord[], select: (record: ChatRecord) => T) {
  const counts: Partial<Record<T, number>> = {};
  for (const record of records) {
    const key = select(record);
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

function rankBy(records: ChatRecord[], select: (record: ChatRecord) => string, limit = TOP_LIMIT): AnalyticsRankItem[] {
  const counts = new Map<string, number>();
  for (const record of records) {
    const label = select(record).trim();
    if (!label) {
      continue;
    }
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  return mapToRank(counts, limit);
}

function rankTerms(records: ChatRecord[], limit = TOP_LIMIT): AnalyticsRankItem[] {
  const counts = new Map<string, number>();
  for (const record of records) {
    for (const term of tokenize(record.content)) {
      counts.set(term, (counts.get(term) ?? 0) + 1);
    }
  }
  return mapToRank(counts, limit);
}

function rankEmotes(records: ChatRecord[], limit = TOP_LIMIT): AnalyticsRankItem[] {
  const counts = new Map<string, number>();
  for (const record of records) {
    for (const emote of record.emotes) {
      const label = emote.token || emote.id;
      if (label) {
        counts.set(label, (counts.get(label) ?? 0) + 1);
      }
    }
  }
  return mapToRank(counts, limit);
}

function mapToRank(counts: Map<string, number>, limit: number): AnalyticsRankItem[] {
  return Array.from(counts.entries())
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, limit)
    .map(([label, count]) => ({ label, count }));
}

function tokenize(content: string) {
  return content
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .map((term) => term.trim())
    .filter((term) => term.length >= 2 && !STOPWORDS.has(term));
}

function percentile(values: number[], ratio: number) {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * ratio) - 1));
  return sorted[index];
}

function round(value: number) {
  return Math.round(value * 10) / 10;
}

export type CountByProvider = Partial<Record<ChatProvider, number>>;
export type CountByRole = Partial<Record<ChatRole, number>>;
