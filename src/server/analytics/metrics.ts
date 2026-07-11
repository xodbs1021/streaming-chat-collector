import type {
  AnalyticsRankItem,
  AnalyticsWindow,
  ChatProvider,
  ChatRecord,
  ChatRole,
  ViewerCountSample
} from "../../shared/types";
import { TOP_LIMIT, mapToRank, round } from "./stats";

export const VIEWER_SAMPLE_MAX_AGE_MS = 150_000;
export const PARTICIPATION_LOOKBACK_MS = 300_000;
export const WINDOW_TOP_LIMIT = 5;

// 배치와 라이브가 공유하는 지표 정의. accumulator는 증분 갱신을 위해 내부적으로 가변(Map/Set)이며,
// finalize 시점에만 불변 스냅샷(AnalyticsWindow / 랭킹 배열)을 만든다.
// 닉네임 신원은 nickname.trim() 하나로 통일한다 — 공백만인 닉네임은 uniqueChatters·chatterCounts·
// chatterLastSeen(참여율 분자) 모두에서 제외한다. providerCounts/roleCounts/terms/emotes는 무조건 갱신.

export interface WindowAgg {
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

export function createWindowAgg(windowStart: number): WindowAgg {
  return {
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
}

export function addToWindowAgg(agg: WindowAgg, record: ChatRecord, tokens: string[]) {
  agg.records.push(record);
  const id = record.nickname.trim();
  if (id) {
    agg.uniqueNicknames.add(id);
    agg.chatterCounts.set(id, (agg.chatterCounts.get(id) ?? 0) + 1);
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
}

export function finalizeWindow(agg: WindowAgg, windowMs: number, viewerCount: number | undefined): AnalyticsWindow {
  const messageCount = agg.records.length;
  return {
    windowStart: agg.windowStart,
    windowEnd: agg.windowStart + windowMs,
    messageCount,
    uniqueChatters: agg.uniqueNicknames.size,
    avgLength: messageCount ? round(agg.lengthSum / messageCount) : 0,
    maxLength: agg.maxLength,
    providerCounts: { ...agg.providerCounts },
    roleCounts: { ...agg.roleCounts },
    topChatters: mapToRank(agg.chatterCounts, WINDOW_TOP_LIMIT),
    topTerms: mapToRank(agg.termCounts, WINDOW_TOP_LIMIT),
    topEmotes: mapToRank(agg.emoteCounts, WINDOW_TOP_LIMIT),
    ...(viewerCount === undefined ? {} : { viewerCount })
  };
}

export interface GlobalAgg {
  uniqueNicknames: Set<string>;
  chatterCounts: Map<string, number>;
  termCounts: Map<string, number>;
  emoteCounts: Map<string, number>;
  providerCounts: Partial<Record<ChatProvider, number>>;
  roleCounts: Partial<Record<ChatRole, number>>;
  chatterLastSeen: Map<string, number>;
}

export function createGlobalAgg(): GlobalAgg {
  return {
    uniqueNicknames: new Set(),
    chatterCounts: new Map(),
    termCounts: new Map(),
    emoteCounts: new Map(),
    providerCounts: {},
    roleCounts: {},
    chatterLastSeen: new Map()
  };
}

export function addToGlobalAgg(agg: GlobalAgg, record: ChatRecord, tokens: string[]) {
  const id = record.nickname.trim();
  if (id) {
    agg.uniqueNicknames.add(id);
    agg.chatterCounts.set(id, (agg.chatterCounts.get(id) ?? 0) + 1);
    const lastSeen = agg.chatterLastSeen.get(id) ?? 0;
    if (record.timestamp > lastSeen) {
      agg.chatterLastSeen.set(id, record.timestamp);
    }
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
}

export function finalizeGlobalTops(agg: GlobalAgg): {
  topChatters: AnalyticsRankItem[];
  topTerms: AnalyticsRankItem[];
  topEmotes: AnalyticsRankItem[];
} {
  return {
    topChatters: mapToRank(agg.chatterCounts, TOP_LIMIT),
    topTerms: mapToRank(agg.termCounts, TOP_LIMIT),
    topEmotes: mapToRank(agg.emoteCounts, TOP_LIMIT)
  };
}

export function countUniqueChatters(records: ChatRecord[]): number {
  const ids = new Set<string>();
  for (const record of records) {
    const id = record.nickname.trim();
    if (id) {
      ids.add(id);
    }
  }
  return ids.size;
}

export function participationRate(
  chatterLastSeen: Map<string, number>,
  viewerSamples: ViewerCountSample[],
  fallbackViewerCount: number | undefined,
  now: number
): number | undefined {
  const cutoff = now - PARTICIPATION_LOOKBACK_MS;
  // 분자(기간 내 채팅러)와 분모(같은 기간의 평균 시청자)를 동일 구간으로 맞춤
  const averageViewers = averageViewerCount(viewerSamples, cutoff) ?? fallbackViewerCount;
  if (averageViewers === undefined || averageViewers <= 0) {
    return undefined;
  }
  let recentChatters = 0;
  for (const lastSeen of chatterLastSeen.values()) {
    if (lastSeen >= cutoff) {
      recentChatters += 1;
    }
  }
  return Math.round((recentChatters / averageViewers) * 1000) / 1000;
}

export function latestViewerCount(samples: ViewerCountSample[], at: number, maxAgeMs = VIEWER_SAMPLE_MAX_AGE_MS) {
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

export function averageViewerCount(samples: ViewerCountSample[], cutoff?: number) {
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
