import { describe, expect, it } from "vitest";
import { LiveAnalytics, summarizeChatRecords } from "../src/server/analytics";
import type { ChatRecord } from "../src/shared/types";

/**
 * B4 안전망 (골든 테스트).
 *
 * analytics.ts는 "레코드를 윈도우로 버킷팅해 지표를 계산"하는 로직을 두 벌 갖고 있다:
 *   - 배치:  summarizeChatRecords → buildWindow / rankBy·rankTerms·rankEmotes
 *   - 라이브: LiveAnalytics → applyToBucketSet + materializeDirty / applyGlobal + getGlobalTops
 *
 * B4(두 경로를 공유 지표 정의로 통합)를 안전하게 하려면, 통합 전 두 경로가
 * "지금 정확히 같은 값을 내는지"를 못 박아야 한다. 이 스위트가 그 계약이다.
 *
 * 벽시계(Date.now)에 의존하는 필드(viewerCount·participationRate)는 여기서 제외한다 —
 * LiveAnalytics.addViewerSample이 샘플 타임스탬프를 스스로 now로 찍어, 배치의 명시적
 * viewerSamples와 결정론적으로 맞추기 어렵기 때문. 그 parity는 B4에서 별도로 다룬다.
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

  // 현재 동작을 못 박는다: 닉네임 신원 처리가 배치와 라이브에서 같아야 한다.
  // (uniqueChatters는 untrimmed, topChatters는 trimmed라는 내부 불일치가 있으나 —
  //  그건 두 경로가 "똑같이" 갖는 특성이라 parity는 유지된다. B4가 이걸 바꾸면 여기서 깨진다.)
  it("treats whitespace in nicknames identically across both paths", () => {
    const records = [
      makeRecord({ timestamp: 100, sequence: 1, nickname: "alice", content: "가" }),
      makeRecord({ timestamp: 200, sequence: 2, nickname: " alice ", content: "나" }),
      makeRecord({ timestamp: 300, sequence: 3, nickname: "  ", content: "다" })
    ];
    assertParity(records, 5);
  });
});
