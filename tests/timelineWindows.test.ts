import { describe, expect, it } from "vitest";
import { MAX_FILLED_SLOTS } from "../src/client/components/dashboard/constants";
import { fillTimelineWindows } from "../src/client/components/dashboard/timelineWindows";
import type { AnalyticsWindow } from "../src/shared/types";

const WINDOW_SEC = 1;
const WINDOW_MS = WINDOW_SEC * 1000;

function makeWindow(windowStart: number, messageCount = 1): AnalyticsWindow {
  return {
    windowStart,
    windowEnd: windowStart + WINDOW_MS,
    messageCount,
    uniqueChatters: messageCount,
    avgLength: 0,
    maxLength: 0,
    providerCounts: {},
    roleCounts: {},
    topChatters: [],
    topTerms: [],
    topEmotes: []
  };
}

describe("fillTimelineWindows — 기존 동작 (padToMs 미지정)", () => {
  it("첫~마지막 사이 내부 공백을 empty 슬롯으로 채운다", () => {
    const windows = [makeWindow(0), makeWindow(3 * WINDOW_MS)];

    const filled = fillTimelineWindows(windows, WINDOW_SEC);

    expect(filled.map((w) => w.windowStart)).toEqual([0, WINDOW_MS, 2 * WINDOW_MS, 3 * WINDOW_MS]);
    expect(filled.map((w) => w.messageCount)).toEqual([1, 0, 0, 1]);
  });

  it("단일 윈도우는 그대로 둔다(축 기준점 하나뿐, 트레일링 연장 없음)", () => {
    const windows = [makeWindow(0)];

    expect(fillTimelineWindows(windows, WINDOW_SEC)).toBe(windows);
  });

  it("빈 배열은 빈 배열 그대로 (축 기준점 없음)", () => {
    expect(fillTimelineWindows([], WINDOW_SEC)).toEqual([]);
  });
});

describe("fillTimelineWindows — 라이브 트레일링 연장 (padToMs 지정)", () => {
  it("마지막 윈도우 뒤 현재 시각 버킷까지 empty 슬롯으로 연장한다", () => {
    const windows = [makeWindow(0), makeWindow(WINDOW_MS)];
    // 마지막(1000) 뒤로 3버킷 떨어진 현재 시각 — 버킷 경계 아닌 값도 floor 처리
    const padToMs = 4 * WINDOW_MS + 500;

    const filled = fillTimelineWindows(windows, WINDOW_SEC, padToMs);

    expect(filled.map((w) => w.windowStart)).toEqual([0, WINDOW_MS, 2 * WINDOW_MS, 3 * WINDOW_MS, 4 * WINDOW_MS]);
    // 실측 2개 + 트레일링 empty 3개
    expect(filled.map((w) => w.messageCount)).toEqual([1, 1, 0, 0, 0]);
  });

  it("단일 윈도우에서도 현재 시각까지 연장한다", () => {
    const windows = [makeWindow(0)];
    const padToMs = 2 * WINDOW_MS + 700;

    const filled = fillTimelineWindows(windows, WINDOW_SEC, padToMs);

    expect(filled.map((w) => w.windowStart)).toEqual([0, WINDOW_MS, 2 * WINDOW_MS]);
    expect(filled.map((w) => w.messageCount)).toEqual([1, 0, 0]);
  });

  it("내부 공백과 트레일링 연장을 동시에 채운다", () => {
    const windows = [makeWindow(0), makeWindow(3 * WINDOW_MS)];
    const padToMs = 5 * WINDOW_MS + 200;

    const filled = fillTimelineWindows(windows, WINDOW_SEC, padToMs);

    expect(filled.map((w) => w.windowStart)).toEqual([0, WINDOW_MS, 2 * WINDOW_MS, 3 * WINDOW_MS, 4 * WINDOW_MS, 5 * WINDOW_MS]);
    expect(filled.map((w) => w.messageCount)).toEqual([1, 0, 0, 1, 0, 0]);
  });

  it("현재 시각이 마지막 윈도우보다 이르면 마지막까지만 채운다(음의 연장 없음)", () => {
    const windows = [makeWindow(0), makeWindow(3 * WINDOW_MS)];
    // padToMs가 마지막 윈도우 이전 — 트레일링 없이 내부 공백만
    const padToMs = 1 * WINDOW_MS;

    const filled = fillTimelineWindows(windows, WINDOW_SEC, padToMs);

    expect(filled.map((w) => w.windowStart)).toEqual([0, WINDOW_MS, 2 * WINDOW_MS, 3 * WINDOW_MS]);
  });
});

describe("fillTimelineWindows — MAX_FILLED_SLOTS 상한", () => {
  it("라이브 연장이 상한을 넘으면 얼리지 않고 최근 상한개 슬롯만 남긴다", () => {
    const windows = [makeWindow(0)];
    // 상한을 훌쩍 넘는 침묵 — 트레일링이 상한보다 길다
    const padToMs = (MAX_FILLED_SLOTS + 5_000) * WINDOW_MS;

    const filled = fillTimelineWindows(windows, WINDOW_SEC, padToMs);

    expect(filled).toHaveLength(MAX_FILLED_SLOTS);
    // 최근 구간을 유지 — 마지막 슬롯은 현재 시각 버킷
    expect(filled[filled.length - 1].windowStart).toBe((MAX_FILLED_SLOTS + 5_000) * WINDOW_MS);
    // 오래된 앞쪽이 잘려 시작점이 밀렸다
    expect(filled[0].windowStart).toBe((MAX_FILLED_SLOTS + 5_000) * WINDOW_MS - (MAX_FILLED_SLOTS - 1) * WINDOW_MS);
  });

  it("padToMs 없는 과거/병합 뷰는 상한 초과 시 기존대로 원본을 그대로 둔다", () => {
    const windows = [makeWindow(0), makeWindow((MAX_FILLED_SLOTS + 5_000) * WINDOW_MS)];

    expect(fillTimelineWindows(windows, WINDOW_SEC)).toBe(windows);
  });
});
