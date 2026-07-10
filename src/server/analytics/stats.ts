import type { AnalyticsRankItem, ChatRecord } from "../../shared/types";
import { tokenize } from "./text";

export const TOP_LIMIT = 8;

export function countUnique(values: string[]) {
  return new Set(values.filter(Boolean)).size;
}

export function countBy<T extends string>(records: ChatRecord[], select: (record: ChatRecord) => T) {
  const counts: Partial<Record<T, number>> = {};
  for (const record of records) {
    const key = select(record);
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

export function rankBy(records: ChatRecord[], select: (record: ChatRecord) => string, limit = TOP_LIMIT): AnalyticsRankItem[] {
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

export function rankTerms(records: ChatRecord[], limit = TOP_LIMIT): AnalyticsRankItem[] {
  const counts = new Map<string, number>();
  for (const record of records) {
    for (const term of tokenize(record.content)) {
      counts.set(term, (counts.get(term) ?? 0) + 1);
    }
  }
  return mapToRank(counts, limit);
}

export function rankEmotes(records: ChatRecord[], limit = TOP_LIMIT): AnalyticsRankItem[] {
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

export function mapToRank(counts: Map<string, number>, limit: number): AnalyticsRankItem[] {
  return Array.from(counts.entries())
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, limit)
    .map(([label, count]) => ({ label, count }));
}

export function percentile(values: number[], ratio: number) {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * ratio) - 1));
  return sorted[index];
}

export function round(value: number) {
  return Math.round(value * 10) / 10;
}
