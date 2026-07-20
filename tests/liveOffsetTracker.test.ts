import { describe, expect, it } from "vitest";
import { LiveOffsetTracker } from "../src/server/offset/liveOffsetTracker";
import { LiveAnalytics, summarizeChatRecords } from "../src/server/analytics";
import type { ChatProvider, ChatRecord } from "../src/shared/types";

const CENTERS = [30, 95, 140, 220, 310, 400, 470, 550];

function bursts(centersSec: number[], perBurst: number, startMs: number): number[] {
  const times: number[] = [];
  for (const center of centersSec) {
    for (let i = 0; i < perBurst; i += 1) {
      times.push(startMs + center * 1000 + ((i * 37) % 1000));
    }
  }
  return times;
}

function makeRecord(provider: ChatProvider, timestamp: number, sequence: number): ChatRecord {
  return {
    provider,
    sourceMode: "unofficial",
    channelId: "ch",
    messageId: `${provider}-${sequence}`,
    nickname: "n",
    role: "viewer",
    badges: [],
    content: "가",
    emotes: [],
    timestamp,
    raw: {},
    sessionId: `bid__${provider}`,
    sequence,
    receivedAt: timestamp
  };
}

describe("LiveOffsetTracker", () => {
  it("웜업 중(신뢰 추정 전)에는 estimating=true, correct는 원본을 그대로 둔다", () => {
    const tracker = new LiveOffsetTracker({ clock: () => 1_000_000 });
    expect(tracker.getStatus().estimating).toBe(true);
    expect(tracker.currentOffsetMs()).toBeUndefined();
    expect(tracker.correct("soop", 123_456)).toBe(123_456);
  });

  it("SOOP 8초 늦은 데이터를 재추정하면 offsetMs≈−8000을 잡고 correct가 anchor 축으로 옮긴다", () => {
    const now = 10_000_000;
    const base = now - 600_000;
    let clock = base;
    const tracker = new LiveOffsetTracker({ clock: () => clock });

    const chzzk = bursts(CENTERS, 10, base);
    const soop = chzzk.map((time) => time + 8_000);
    for (const time of chzzk) {
      tracker.observe("chzzk", time);
    }
    for (const time of soop) {
      tracker.observe("soop", time);
    }
    clock = now;

    const change = tracker.reestimate();

    expect(change).toBeDefined();
    expect(change?.firstConfident).toBe(true);
    expect(Math.abs((tracker.currentOffsetMs() ?? 0) - -8_000)).toBeLessThanOrEqual(1_000);
    expect(tracker.getStatus().estimating).toBe(false);
    // correct: soop 레코드를 anchor 축으로 (≈ −8000 이동)
    const soopTime = base + 100_000;
    expect(tracker.correct("soop", soopTime)).toBeLessThan(soopTime);
    expect(tracker.correct("chzzk", soopTime)).toBe(soopTime); // 치지직은 그대로
  });

  it("증거 부족이면 재추정이 undefined이고 estimating을 유지한다", () => {
    const tracker = new LiveOffsetTracker({ clock: () => 5_000_000 });
    tracker.observe("chzzk", 4_999_000);
    tracker.observe("soop", 4_999_000);
    expect(tracker.reestimate()).toBeUndefined();
    expect(tracker.getStatus().estimating).toBe(true);
  });

  it("reset이 관측·offset 상태를 비운다", () => {
    const now = 10_000_000;
    const base = now - 600_000;
    let clock = base;
    const tracker = new LiveOffsetTracker({ clock: () => clock });
    for (const time of bursts(CENTERS, 10, base)) {
      tracker.observe("chzzk", time);
      tracker.observe("soop", time + 8_000);
    }
    clock = now;
    tracker.reestimate();
    tracker.reset();
    expect(tracker.currentOffsetMs()).toBeUndefined();
    expect(tracker.getStatus().estimating).toBe(true);
  });
});

describe("LiveAnalytics.retimeProvider", () => {
  it("한 provider의 레코드를 deltaMs만큼 옮기고 집계를 배치와 일치시킨다(batch-parity)", () => {
    const records = [
      makeRecord("chzzk", 1_000, 1),
      makeRecord("soop", 2_000, 2),
      makeRecord("chzzk", 8_000, 3),
      makeRecord("soop", 9_500, 4),
      makeRecord("soop", 15_000, 5)
    ];
    const live = new LiveAnalytics();
    for (const record of records) {
      live.append(record);
    }

    const deltaMs = -3_000;
    live.retimeProvider("soop", deltaMs);

    const shifted = records.map((record) =>
      record.provider === "soop" ? { ...record, timestamp: record.timestamp + deltaMs } : record
    );
    const batch = summarizeChatRecords(shifted, 5);

    expect(live.getSummary(undefined, 5).windows).toEqual(batch.windows);
  });

  it("deltaMs=0이면 아무것도 바꾸지 않는다", () => {
    const live = new LiveAnalytics();
    live.append(makeRecord("soop", 4_000, 1));
    const before = live.getSummary(undefined, 5).windows;
    live.retimeProvider("soop", 0);
    expect(live.getSummary(undefined, 5).windows).toEqual(before);
  });
});
