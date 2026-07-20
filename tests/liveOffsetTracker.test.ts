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

describe("LiveOffsetTracker 적용 축(applied) 일관성 + 재발화 게이트", () => {
  /** [base, base+600초] 창에 SOOP이 soopDelayMs만큼 늦은 정렬 버스트를 관측시킨다(복원 offset = −soopDelayMs). */
  function observeAligned(tracker: LiveOffsetTracker, base: number, soopDelayMs: number) {
    for (const time of bursts(CENTERS, 12, base)) {
      tracker.observe("chzzk", time);
      tracker.observe("soop", time + soopDelayMs);
    }
  }

  it("firstConfident는 1회성 — 2번째 confident에서 재발화하지 않고 sub-2초 흔들림은 applied를 유지한다", () => {
    let clock = 0;
    const tracker = new LiveOffsetTracker({ clock: () => clock });

    // 1주기: SOOP 8초 늦음 → 복원 −8000, 첫 신뢰(firstConfident) + applied 채택
    observeAligned(tracker, 0, 8_000);
    clock = 600_000;
    const first = tracker.reestimate();
    expect(first?.firstConfident).toBe(true);
    const appliedAfterFirst = tracker.currentOffsetMs();

    // 2주기: 1000ms 드리프트(sub-2초) — 옛 데이터는 창 밖으로(now=1_300_000, 창 [700_000, ...])
    observeAligned(tracker, 700_000, 9_000);
    clock = 1_300_000;
    const second = tracker.reestimate();

    expect(second).toBeUndefined(); // 재발화 안 함(retime 없음)
    expect(tracker.currentOffsetMs()).toBe(appliedAfterFirst); // applied 불변(축 일관)
  });

  it(">2초 점프에서만 retime이 발화하고 delta 부호가 맞다", () => {
    let clock = 0;
    const tracker = new LiveOffsetTracker({ clock: () => clock });
    observeAligned(tracker, 0, 8_000);
    clock = 600_000;
    tracker.reestimate(); // applied = −8000

    // SOOP이 3초 더 늦어짐(11초 → 복원 −11000): |Δ|=3000 > 2000 → 채택
    observeAligned(tracker, 700_000, 11_000);
    clock = 1_300_000;
    const jump = tracker.reestimate();

    expect(jump).toBeDefined();
    expect(jump?.firstConfident).toBe(false);
    expect(jump?.deltaMs).toBeLessThan(0); // −11000 − (−8000) = −3000
    expect(Math.abs((jump?.deltaMs ?? 0) - -3_000)).toBeLessThanOrEqual(1_000);
    expect(Math.abs((tracker.currentOffsetMs() ?? 0) - -11_000)).toBeLessThanOrEqual(1_000);
  });

  it("reset 후에는 웜업이 다시 시작돼 firstConfident가 재발화한다", () => {
    let clock = 0;
    const tracker = new LiveOffsetTracker({ clock: () => clock });
    observeAligned(tracker, 0, 8_000);
    clock = 600_000;
    expect(tracker.reestimate()?.firstConfident).toBe(true);

    tracker.reset();
    expect(tracker.getStatus().estimating).toBe(true);

    observeAligned(tracker, 2_000_000, 5_000);
    clock = 2_600_000;
    expect(tracker.reestimate()?.firstConfident).toBe(true); // 리셋 후 다시 1회성
  });

  it("enabled=false면 getStatus.enabled가 false(배지가 '보정 꺼짐' 판단)", () => {
    expect(new LiveOffsetTracker({ enabled: false }).getStatus().enabled).toBe(false);
    expect(new LiveOffsetTracker().getStatus().enabled).toBe(true); // 기본 on
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
