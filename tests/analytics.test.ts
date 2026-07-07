import { describe, expect, it } from "vitest";
import { LiveAnalytics, summarizeChatRecords, summarizeHighlightCandidates, summarizeWindowComparison } from "../src/server/analytics";
import type { ChatRecord } from "../src/shared/types";

describe("chat analytics", () => {
  it("groups messages into fixed 5 second windows", () => {
    const summary = summarizeChatRecords([
      makeRecord({ timestamp: 0, sequence: 1, nickname: "a", content: "안녕 좋아요" }),
      makeRecord({ timestamp: 4_999, sequence: 2, nickname: "b", content: "안녕" }),
      makeRecord({ timestamp: 5_000, sequence: 3, nickname: "a", provider: "soop", role: "manager", content: "분석 좋아요" })
    ]);

    expect(summary.windows).toHaveLength(2);
    expect(summary.windows[0]).toMatchObject({
      windowStart: 0,
      windowEnd: 5_000,
      messageCount: 2,
      uniqueChatters: 2,
      providerCounts: { chzzk: 2 }
    });
    expect(summary.windows[1]).toMatchObject({
      windowStart: 5_000,
      messageCount: 1,
      providerCounts: { soop: 1 },
      roleCounts: { manager: 1 }
    });
  });

  it("supports custom 1 second windows", () => {
    const summary = summarizeChatRecords(
      [
        makeRecord({ timestamp: 999, sequence: 1 }),
        makeRecord({ timestamp: 1_000, sequence: 2 }),
        makeRecord({ timestamp: 1_999, sequence: 3 })
      ],
      1
    );

    expect(summary.windowSec).toBe(1);
    expect(summary.windows).toHaveLength(2);
    expect(summary.windows[0]).toMatchObject({ windowStart: 0, windowEnd: 1_000, messageCount: 1 });
    expect(summary.windows[1]).toMatchObject({ windowStart: 1_000, windowEnd: 2_000, messageCount: 2 });
  });

  it("calculates top chatters, terms, emotes, and recent messages", () => {
    const summary = summarizeChatRecords([
      makeRecord({ sequence: 1, nickname: "초록별", content: "분석 분석 the", emotes: [{ id: "e1", token: ":gg:", url: "" }] }),
      makeRecord({ sequence: 2, nickname: "초록별", content: "채팅 분석" }),
      makeRecord({ sequence: 3, nickname: "방송친구", content: "채팅" })
    ]);

    expect(summary.totalMessages).toBe(3);
    expect(summary.uniqueChatters).toBe(2);
    expect(summary.topChatters[0]).toEqual({ label: "초록별", count: 2 });
    expect(summary.topTerms).toEqual(expect.arrayContaining([{ label: "분석", count: 3 }]));
    expect(summary.topEmotes).toEqual([{ label: ":gg:", count: 1 }]);
    expect(summary.recentMessages[0].sequence).toBe(3);
  });

  it("adds viewer count and participation rate from viewer samples", () => {
    const now = Date.now();
    const summary = summarizeChatRecords(
      [
        makeRecord({ timestamp: now - 2_000, sequence: 1, nickname: "a" }),
        makeRecord({ timestamp: now - 1_000, sequence: 2, nickname: "b" })
      ],
      5,
      undefined,
      [
        { provider: "chzzk", timestamp: now - 10_000, count: 80 },
        { provider: "soop", timestamp: now - 5_000, count: 20 }
      ]
    );

    expect(summary.viewerCount).toBe(100);
    expect(summary.participationRate).toBeCloseTo(0.02);
    expect(summary.windows.at(-1)?.viewerCount).toBe(100);
  });

  it("ignores stale viewer samples", () => {
    const now = Date.now();
    const summary = summarizeChatRecords(
      [makeRecord({ timestamp: now - 1_000, sequence: 1 })],
      5,
      undefined,
      [{ provider: "chzzk", timestamp: now - 400_000, count: 80 }]
    );

    expect(summary.viewerCount).toBeUndefined();
    expect(summary.participationRate).toBeUndefined();
  });

  it("classifies highlight candidates by active mean, p95, and p99", () => {
    const records = Array.from({ length: 100 }, (_, windowIndex) =>
      Array.from({ length: windowIndex + 1 }, (_, messageIndex) =>
        makeRecord({
          sequence: windowIndex * 100 + messageIndex + 1,
          timestamp: windowIndex * 3_000,
          content: `한타 ${windowIndex + 1}`
        })
      )
    ).flat();

    const summary = summarizeHighlightCandidates(records, 1);

    expect(summary.thresholds).toMatchObject({
      activeWindowMean: 50.5,
      p95: 95,
      p99: 99,
      max: 100
    });
    expect(summary.candidates.some((candidate) => candidate.peakCount === 50)).toBe(false);
    expect(summary.candidates.find((candidate) => candidate.peakCount === 51)?.level).toBe("review");
    expect(summary.candidates.find((candidate) => candidate.peakCount === 95)?.level).toBe("highlight");
    expect(summary.candidates.find((candidate) => candidate.peakCount === 99)?.level).toBe("strong");
  });

  it("merges nearby candidate windows and calculates candidate stats", () => {
    const records = [
      ...makeWindowRecords(0, 1, "평범"),
      ...makeWindowRecords(5_000, 1, "평범"),
      ...makeWindowRecords(10_000, 1, "평범"),
      ...makeWindowRecords(30_000, 20, "한타 대박"),
      ...makeWindowRecords(35_000, 1, "정리"),
      ...makeWindowRecords(40_000, 22, "펜타킬")
    ];

    const summary = summarizeHighlightCandidates(records, 5);

    expect(summary.candidates).toHaveLength(1);
    expect(summary.candidates[0]).toMatchObject({
      startAt: 30_000,
      endAt: 45_000,
      durationSec: 15,
      peakCount: 22,
      totalMessages: 43,
      uniqueChatters: 43,
      level: "strong"
    });
    expect(summary.candidates[0].score).toBeGreaterThan(2);
    expect(summary.candidates[0].topTerms).toEqual(expect.arrayContaining([{ label: "펜타킬", count: 22 }]));
  });

  it("compares highlight sensitivity across window sizes", () => {
    const records = [
      ...makeWindowRecords(0, 5, "초반"),
      ...makeWindowRecords(1_000, 12, "한타"),
      ...makeWindowRecords(3_000, 3, "정리"),
      ...makeWindowRecords(10_000, 20, "오브젝트")
    ];

    const comparison = summarizeWindowComparison(records, [1, 3, 5]);

    expect(comparison.items.map((item) => item.windowSec)).toEqual([1, 3, 5]);
    expect(comparison.items[0]).toMatchObject({
      totalMessages: records.length,
      windowSec: 1
    });
    expect(comparison.items.some((item) => item.candidateWindowCount > 0)).toBe(true);
  });
});

describe("live analytics incremental summary", () => {
  it("matches the batch summarizer for the same records", () => {
    const records = [
      makeRecord({ timestamp: 0, sequence: 1, nickname: "a", content: "안녕 좋아요", emotes: [{ id: "e1", token: ":gg:", url: "" }] }),
      makeRecord({ timestamp: 4_999, sequence: 2, nickname: "b", content: "안녕" }),
      makeRecord({ timestamp: 5_000, sequence: 3, nickname: "a", provider: "soop", role: "manager", content: "분석 좋아요" })
    ];
    const live = new LiveAnalytics();
    for (const record of records) {
      live.append(record);
    }

    const expected = summarizeChatRecords(records, 5);
    const actual = live.getSummary(undefined, 5);

    expect(actual.windows).toEqual(expected.windows);
    expect(actual.totalMessages).toBe(expected.totalMessages);
    expect(actual.uniqueChatters).toBe(expected.uniqueChatters);
    expect(actual.providerCounts).toEqual(expected.providerCounts);
    expect(actual.roleCounts).toEqual(expected.roleCounts);
    expect(actual.topChatters).toEqual(expected.topChatters);
    expect(actual.topTerms).toEqual(expected.topTerms);
    expect(actual.topEmotes).toEqual(expected.topEmotes);
    expect(actual.recentMessages).toEqual(expected.recentMessages);
  });

  it("handles out-of-order records like the batch summarizer", () => {
    const records = [
      makeRecord({ timestamp: 6_000, sequence: 1, nickname: "c", content: "셋" }),
      makeRecord({ timestamp: 1_000, sequence: 2, nickname: "a", content: "하나" }),
      makeRecord({ timestamp: 3_000, sequence: 3, nickname: "b", content: "둘" })
    ];
    const live = new LiveAnalytics();
    for (const record of records) {
      live.append(record);
    }

    const expected = summarizeChatRecords(records, 5);
    const actual = live.getSummary(undefined, 5);

    expect(actual.windows).toEqual(expected.windows);
    expect(actual.recentMessages).toEqual(expected.recentMessages);
  });

  it("returns only recent windows when recentWindowLimit is set", () => {
    const live = new LiveAnalytics();
    for (let index = 0; index < 10; index += 1) {
      live.append(makeRecord({ timestamp: index * 5_000, sequence: index + 1, messageId: `message-${index}` }));
    }

    const summary = live.getSummary(undefined, 5, [], { recentWindowLimit: 3 });

    expect(summary.partialWindows).toBe(true);
    expect(summary.windows).toHaveLength(3);
    expect(summary.windows[0].windowStart).toBe(7 * 5_000);
    expect(summary.totalMessages).toBe(10);

    const fullSummary = live.getSummary(undefined, 5);
    expect(fullSummary.partialWindows).toBeUndefined();
    expect(fullSummary.windows).toHaveLength(10);
  });

  it("counts keywords per window on demand", () => {
    const live = new LiveAnalytics();
    live.append(makeRecord({ timestamp: 0, sequence: 1, content: "한타 대박" }));
    live.append(makeRecord({ timestamp: 1_000, sequence: 2, content: "한타 한타" }));
    live.append(makeRecord({ timestamp: 6_000, sequence: 3, content: "평화" }));

    const summary = live.getSummary(undefined, 5, ["한타"]);

    expect(summary.windows[0].keywordCounts).toEqual({ 한타: 2 });
    expect(summary.windows[1].keywordCounts).toEqual({ 한타: 0 });
  });

  it("clears aggregates on reset", () => {
    const live = new LiveAnalytics();
    live.append(makeRecord({ sequence: 1 }));
    live.reset();

    const summary = live.getSummary(undefined, 5);

    expect(summary.totalMessages).toBe(0);
    expect(summary.windows).toHaveLength(0);
    expect(summary.topChatters).toHaveLength(0);
    expect(summary.uniqueChatters).toBe(0);
  });

  it("serves multiple window sizes without cross-contamination", () => {
    const live = new LiveAnalytics();
    live.append(makeRecord({ timestamp: 0, sequence: 1 }));
    live.append(makeRecord({ timestamp: 1_500, sequence: 2 }));

    expect(live.getSummary(undefined, 5).windows).toHaveLength(1);
    expect(live.getSummary(undefined, 1).windows).toHaveLength(2);

    live.append(makeRecord({ timestamp: 6_000, sequence: 3 }));

    expect(live.getSummary(undefined, 5).windows).toHaveLength(2);
    expect(live.getSummary(undefined, 1).windows).toHaveLength(3);
  });
});

function makeRecord(patch: Partial<ChatRecord>): ChatRecord {
  return {
    provider: "chzzk",
    sourceMode: "official",
    channelId: "channel-1",
    messageId: `message-${patch.sequence ?? 1}`,
    nickname: "테스터",
    role: "viewer",
    badges: [],
    content: "테스트",
    emotes: [],
    timestamp: 1_720_000_000_000,
    raw: {},
    sessionId: "session-1",
    sequence: 1,
    receivedAt: 1_720_000_000_000,
    ...patch
  };
}

function makeWindowRecords(timestamp: number, count: number, content: string) {
  return Array.from({ length: count }, (_, index) =>
    makeRecord({
      sequence: timestamp + index + 1,
      messageId: `message-${timestamp}-${index}`,
      nickname: `테스터-${timestamp}-${index}`,
      timestamp,
      content
    })
  );
}
