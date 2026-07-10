import type { ChatRecord } from "../../shared/types";

const MAX_KEYWORDS = 8;

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

export function tokenize(content: string) {
  return content
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .map((term) => term.trim())
    .filter((term) => term.length >= 2 && !STOPWORDS.has(term));
}

export function countKeywords(records: ChatRecord[], keywords: string[]): Record<string, number> | undefined {
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
