import { describe, expect, it } from "vitest";
import { LiveAnalytics, summarizeChatRecords } from "../src/server/analytics";
import type { ChatRecord, ViewerCountSample } from "../src/shared/types";

/**
 * B4 안전망 (골든 테스트).
 *
 * analytics.ts는 "레코드를 윈도우로 버킷팅해 지표를 계산"하는 로직을 배치·라이브 두 경로로 갖고 있고,
 * B4에서 공유 지표 정의(analytics/metrics.ts)로 통합했다. 이 스위트는 두 경로가 "정확히 같은 값을
 * 내는지"를 못 박는 계약이다.
 *
 * 아래 첫 스위트는 벽시계 비의존 필드(windows·집계·랭킹)를 대조한다. 벽시계(now)에 의존하는
 * 필드(viewerCount·participationRate)는 두 번째 스위트에서 clock 주입으로 결정론적으로 맞춘다 —
 * LiveAnalytics(clock)와 summarizeChatRecords(..., now)에 동일한 가짜 시계를 넣는다.
 */

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
    timestamp: 0,
    raw: {},
    sessionId: "session-1",
    sequence: 1,
    receivedAt: 0,
    ...patch
  };
}

/** 벽시계 비의존 필드 전체를 배치와 라이브가 동일하게 내는지 대조 */
function assertParity(records: ChatRecord[], windowSec: number) {
  const live = new LiveAnalytics();
  for (const record of records) {
    live.append(record);
  }
  const batch = summarizeChatRecords(records, windowSec);
  const actual = live.getSummary(undefined, windowSec);

  expect(actual.windows).toEqual(batch.windows);
  expect(actual.totalMessages).toBe(batch.totalMessages);
  expect(actual.uniqueChatters).toBe(batch.uniqueChatters);
  expect(actual.providerCounts).toEqual(batch.providerCounts);
  expect(actual.roleCounts).toEqual(batch.roleCounts);
  expect(actual.topChatters).toEqual(batch.topChatters);
  expect(actual.topTerms).toEqual(batch.topTerms);
  expect(actual.topEmotes).toEqual(batch.topEmotes);
  expect(actual.recentMessages).toEqual(batch.recentMessages);
  expect(actual.startedAt).toBe(batch.startedAt);
  expect(actual.endedAt).toBe(batch.endedAt);
}

// 여러 윈도우에 걸친, 프로바이더·역할·이모트·중복 닉네임·불용어가 섞인 적대적 데이터셋.
// 삽입 순서는 일부러 흐트러 놓아(라이브의 out-of-order insertSorted 경로) 배치와 맞는지 본다.
function buildAdversarialRecords(): ChatRecord[] {
  const rows: Array<Partial<ChatRecord>> = [
    { timestamp: 200, nickname: "초록별", content: "분석 분석 진짜", emotes: [{ id: "e1", token: ":gg:", url: "" }] },
    { timestamp: 12_500, nickname: "방송친구", content: "한타 대박 ㅋㅋ", provider: "soop", role: "manager" },
    { timestamp: 4_800, nickname: "초록별", content: "채팅 분석", role: "manager" },
    { timestamp: 300, nickname: "방송친구", content: "안녕 the and", provider: "soop" },
    { timestamp: 9_100, nickname: "구경꾼", content: "한타 한타 한타", emotes: [{ id: "e2", token: ":omg:", url: "" }] },
    { timestamp: 5_050, nickname: "초록별", content: "오브젝트 분석", provider: "soop" },
    { timestamp: 22_400, nickname: "구경꾼", content: "펜타킬 대박", emotes: [{ id: "e1", token: ":gg:", url: "" }] },
    { timestamp: 8_800, nickname: "방송친구", content: "정리 정리", role: "manager" },
    { timestamp: 17_000, nickname: "초록별", content: "분석 오브젝트 대박" },
    { timestamp: 13_200, nickname: "구경꾼", content: "한타 the you", provider: "soop" },
    { timestamp: 600, nickname: "구경꾼", content: "안녕 좋아요" },
    { timestamp: 22_100, nickname: "방송친구", content: "펜타킬 펜타킬", provider: "soop", role: "manager", emotes: [{ id: "e2", token: ":omg:", url: "" }] }
  ];
  return rows.map((row, index) =>
    makeRecord({ ...row, sequence: index + 1, messageId: `msg-${index + 1}`, receivedAt: row.timestamp ?? 0 })
  );
}

describe("batch vs live analytics parity (B4 golden net)", () => {
  const records = buildAdversarialRecords();

  for (const windowSec of [1, 3, 5, 10]) {
    it(`produces identical windows and aggregates at windowSec=${windowSec}`, () => {
      assertParity(records, windowSec);
    });
  }

  it("stays in parity for a single record", () => {
    assertParity([makeRecord({ timestamp: 1_234, nickname: "혼자", content: "하나" })], 5);
  });

  it("stays in parity when every record shares one window", () => {
    const sameWindow = Array.from({ length: 8 }, (_, index) =>
      makeRecord({ timestamp: index * 100, sequence: index + 1, messageId: `w-${index}`, nickname: `n${index % 3}`, content: `말 ${index % 2}` })
    );
    assertParity(sameWindow, 5);
  });

  // 닉네임 신원이 배치와 라이브에서 같아야 한다. B4에서 신원을 nickname.trim()으로 통일했으므로
  // uniqueChatters·topChatters·chatterLastSeen 모두 trimmed 기준이다: "alice"와 " alice "는 한 사람으로
  // 합쳐지고 공백만인 닉네임은 제외된다(이 케이스의 uniqueChatters는 3이 아니라 1). 두 경로가 동일하게
  // 그 규칙을 따르므로 parity는 유지된다.
  it("treats whitespace in nicknames identically across both paths", () => {
    const records = [
      makeRecord({ timestamp: 100, sequence: 1, nickname: "alice", content: "가" }),
      makeRecord({ timestamp: 200, sequence: 2, nickname: " alice ", content: "나" }),
      makeRecord({ timestamp: 300, sequence: 3, nickname: "  ", content: "다" })
    ];
    assertParity(records, 5);
  });
});

// 벽시계(now) 의존 필드 parity — 가짜 clock을 배치·라이브 양쪽에 동일하게 주입해 결정론적으로 대조한다.
// 라이브는 new LiveAnalytics(clock), 배치는 summarizeChatRecords(..., now). viewerSamples는 clock을
// 미리 세팅하고 addViewerSample을 호출해 라이브가 찍는 타임스탬프를 배치의 명시 샘플과 맞춘다.
describe("batch vs live wall-clock parity (B4 clock injection)", () => {
  const MAX_AGE_MS = 150_000;
  const LOOKBACK_MS = 300_000;

  // 동일한 viewerSamples 배열로 라이브를 채운다: 각 샘플 시점으로 시계를 옮긴 뒤 addViewerSample 호출.
  function feedLive(live: LiveAnalytics, setNow: (at: number) => void, samples: ViewerCountSample[]) {
    for (const sample of samples) {
      setNow(sample.timestamp);
      live.addViewerSample(sample.provider, sample.count);
    }
  }

  it("agrees on global viewerCount across providers", () => {
    let now = 1_000_000;
    const samples: ViewerCountSample[] = [
      { provider: "chzzk", timestamp: now - 10_000, count: 100 },
      { provider: "chzzk", timestamp: now - 5_000, count: 120 },
      { provider: "soop", timestamp: now - 3_000, count: 40 }
    ];
    const live = new LiveAnalytics(() => now);
    feedLive(live, (at) => (now = at), samples);
    now = 1_000_000;

    const batch = summarizeChatRecords([], 5, undefined, samples, [], now);
    const summary = live.getSummary(undefined, 5);

    expect(summary.viewerCount).toBe(160);
    expect(summary.viewerCount).toBe(batch.viewerCount);
  });

  it("agrees on per-window viewerCount within the sample max age", () => {
    const base = 5_000_000;
    let now = base;
    const records = [
      makeRecord({ timestamp: base, sequence: 1, messageId: "w-1", nickname: "a", content: "가" }),
      makeRecord({ timestamp: base + 1_000, sequence: 2, messageId: "w-2", nickname: "b", content: "나" })
    ];
    // 윈도우 [base, base+5000)의 windowEnd=base+5000, 샘플은 그 이내(age 3000 < MAX_AGE)라 잡힌다.
    const samples: ViewerCountSample[] = [{ provider: "chzzk", timestamp: base + 2_000, count: 77 }];
    const live = new LiveAnalytics(() => now);
    feedLive(live, (at) => (now = at), samples);
    for (const record of records) {
      live.append(record);
    }
    now = base + 10_000;

    const batch = summarizeChatRecords(records, 5, undefined, samples, [], now);
    const summary = live.getSummary(undefined, 5);

    expect(summary.windows).toEqual(batch.windows);
    expect(summary.windows[0]?.viewerCount).toBe(77);
    expect(now - MAX_AGE_MS).toBeLessThan(base + 2_000);
  });

  it("agrees on participationRate for records straddling the lookback cutoff", () => {
    const t = 2_000_000;
    let now = t;
    const cutoff = t - LOOKBACK_MS;
    const records = [
      makeRecord({ timestamp: t - 10_000, sequence: 1, messageId: "p-1", nickname: "a", content: "가" }),
      makeRecord({ timestamp: t - 20_000, sequence: 2, messageId: "p-2", nickname: "b", content: "나" }),
      makeRecord({ timestamp: cutoff - 100_000, sequence: 3, messageId: "p-3", nickname: "c", content: "다" })
    ];
    const samples: ViewerCountSample[] = [{ provider: "chzzk", timestamp: t - 5_000, count: 50 }];
    const live = new LiveAnalytics(() => now);
    feedLive(live, (at) => (now = at), samples);
    for (const record of records) {
      live.append(record);
    }
    now = t;

    const batch = summarizeChatRecords(records, 5, undefined, samples, [], now);
    const summary = live.getSummary(undefined, 5);

    // 분자: cutoff 이후 채팅러 a·b = 2, c는 제외. 분모: 평균 시청자 50. => 2/50 = 0.04
    expect(summary.participationRate).toBe(0.04);
    expect(summary.participationRate).toBe(batch.participationRate);
  });

  it("agrees that viewerCount is undefined when only stale samples exist", () => {
    const t = 3_000_000;
    let now = t;
    const samples: ViewerCountSample[] = [{ provider: "chzzk", timestamp: t - 200_000, count: 30 }];
    const live = new LiveAnalytics(() => now);
    feedLive(live, (at) => (now = at), samples);
    now = t;

    const batch = summarizeChatRecords([], 5, undefined, samples, [], now);
    const summary = live.getSummary(undefined, 5);

    expect(summary.viewerCount).toBeUndefined();
    expect(batch.viewerCount).toBeUndefined();
  });

  it("agrees that both metrics are undefined when no samples exist", () => {
    const t = 3_500_000;
    let now = t;
    const records = [makeRecord({ timestamp: t - 1_000, sequence: 1, nickname: "a", content: "가" })];
    const live = new LiveAnalytics(() => now);
    for (const record of records) {
      live.append(record);
    }
    now = t;

    const batch = summarizeChatRecords(records, 5, undefined, [], [], now);
    const summary = live.getSummary(undefined, 5);

    expect(summary.viewerCount).toBeUndefined();
    expect(batch.viewerCount).toBeUndefined();
    expect(summary.participationRate).toBeUndefined();
    expect(batch.participationRate).toBeUndefined();
  });

  it("agrees on trimmed-identity participation numerator", () => {
    const t = 4_000_000;
    let now = t;
    // 신원 통일: "alice"와 " alice "는 한 사람, "  "는 제외 => 분자 1.
    const records = [
      makeRecord({ timestamp: t - 1_000, sequence: 1, messageId: "t-1", nickname: "alice", content: "가" }),
      makeRecord({ timestamp: t - 2_000, sequence: 2, messageId: "t-2", nickname: " alice ", content: "나" }),
      makeRecord({ timestamp: t - 3_000, sequence: 3, messageId: "t-3", nickname: "  ", content: "다" })
    ];
    const samples: ViewerCountSample[] = [{ provider: "chzzk", timestamp: t - 1_000, count: 25 }];
    const live = new LiveAnalytics(() => now);
    feedLive(live, (at) => (now = at), samples);
    for (const record of records) {
      live.append(record);
    }
    now = t;

    const batch = summarizeChatRecords(records, 5, undefined, samples, [], now);
    const summary = live.getSummary(undefined, 5);

    // 분자 1, 분모 25 => 1/25 = 0.04
    expect(summary.participationRate).toBe(0.04);
    expect(summary.participationRate).toBe(batch.participationRate);
    expect(summary.uniqueChatters).toBe(1);
    expect(batch.uniqueChatters).toBe(1);
  });
});
