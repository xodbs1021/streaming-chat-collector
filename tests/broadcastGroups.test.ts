import { describe, expect, it } from "vitest";
import {
  defaultSessionOf,
  findGroupOf,
  groupSessionsByBroadcast
} from "../src/client/components/dashboard/broadcastGroups";
import type { RecordingSession } from "../src/shared/types";

function makeSession(overrides: Partial<RecordingSession> & Pick<RecordingSession, "sessionId" | "provider">): RecordingSession {
  return {
    sourceMode: "unofficial",
    channelId: "ch",
    startedAt: 1_000,
    messageCount: 0,
    fileName: `${overrides.sessionId}.jsonl`,
    ...overrides
  };
}

describe("groupSessionsByBroadcast", () => {
  it("merges sessions sharing a broadcastId into one group with chzzk first", () => {
    const soop = makeSession({ sessionId: "b1__soop", broadcastId: "b1", provider: "soop", startedAt: 2_000, messageCount: 3 });
    const chzzk = makeSession({ sessionId: "b1__chzzk", broadcastId: "b1", provider: "chzzk", startedAt: 1_000, messageCount: 5 });

    const groups = groupSessionsByBroadcast([soop, chzzk]);

    expect(groups).toHaveLength(1);
    expect(groups[0].groupKey).toBe("b1");
    // PROVIDER_ORDER 정렬 — soop가 먼저 들어와도 chzzk가 sessions[0]
    expect(groups[0].sessions.map((s) => s.provider)).toEqual(["chzzk", "soop"]);
  });

  it("sums messageCount and takes the minimum startedAt across siblings", () => {
    const soop = makeSession({ sessionId: "b1__soop", broadcastId: "b1", provider: "soop", startedAt: 2_000, messageCount: 3 });
    const chzzk = makeSession({ sessionId: "b1__chzzk", broadcastId: "b1", provider: "chzzk", startedAt: 1_000, messageCount: 5 });

    const [group] = groupSessionsByBroadcast([soop, chzzk]);

    expect(group.totalMessageCount).toBe(8);
    expect(group.startedAt).toBe(1_000);
  });

  it("falls back to a one-session group keyed by sessionId when broadcastId is missing (legacy)", () => {
    const legacy = makeSession({ sessionId: "legacy-1", provider: "chzzk", messageCount: 4 });

    const groups = groupSessionsByBroadcast([legacy]);

    expect(groups).toHaveLength(1);
    expect(groups[0].groupKey).toBe("legacy-1");
    expect(groups[0].broadcastId).toBeUndefined();
    expect(groups[0].sessions).toHaveLength(1);
  });

  it("keeps a single-provider broadcast as a one-session group", () => {
    const only = makeSession({ sessionId: "b2__chzzk", broadcastId: "b2", provider: "chzzk", messageCount: 7 });

    const groups = groupSessionsByBroadcast([only]);

    expect(groups).toHaveLength(1);
    expect(groups[0].groupKey).toBe("b2");
    expect(groups[0].sessions).toHaveLength(1);
  });

  it("orders groups by startedAt descending (newest broadcast first)", () => {
    const older = makeSession({ sessionId: "old__chzzk", broadcastId: "old", provider: "chzzk", startedAt: 1_000 });
    const newer = makeSession({ sessionId: "new__chzzk", broadcastId: "new", provider: "chzzk", startedAt: 5_000 });

    const groups = groupSessionsByBroadcast([older, newer]);

    expect(groups.map((g) => g.groupKey)).toEqual(["new", "old"]);
  });

  it("carries the first truthy displayName in PROVIDER_ORDER, else undefined", () => {
    const chzzk = makeSession({ sessionId: "b1__chzzk", broadcastId: "b1", provider: "chzzk", displayName: "롤 랭크" });
    const soop = makeSession({ sessionId: "b1__soop", broadcastId: "b1", provider: "soop", displayName: "무시됨" });
    const noName = makeSession({ sessionId: "b3__chzzk", broadcastId: "b3", provider: "chzzk" });

    const [named] = groupSessionsByBroadcast([soop, chzzk]);
    const [unnamed] = groupSessionsByBroadcast([noName]);

    expect(named.displayName).toBe("롤 랭크");
    expect(unnamed.displayName).toBeUndefined();
  });
});

describe("findGroupOf", () => {
  it("returns the group a sessionId belongs to", () => {
    const chzzk = makeSession({ sessionId: "b1__chzzk", broadcastId: "b1", provider: "chzzk" });
    const soop = makeSession({ sessionId: "b1__soop", broadcastId: "b1", provider: "soop" });
    const groups = groupSessionsByBroadcast([chzzk, soop]);

    expect(findGroupOf(groups, "b1__soop")?.groupKey).toBe("b1");
  });

  it("returns undefined when no group owns the sessionId (e.g. live)", () => {
    const groups = groupSessionsByBroadcast([makeSession({ sessionId: "b1__chzzk", broadcastId: "b1", provider: "chzzk" })]);

    expect(findGroupOf(groups, "live")).toBeUndefined();
  });
});

describe("defaultSessionOf", () => {
  it("picks the session with the most messages", () => {
    const chzzk = makeSession({ sessionId: "b1__chzzk", broadcastId: "b1", provider: "chzzk", messageCount: 2 });
    const soop = makeSession({ sessionId: "b1__soop", broadcastId: "b1", provider: "soop", messageCount: 9 });
    const [group] = groupSessionsByBroadcast([chzzk, soop]);

    expect(defaultSessionOf(group).sessionId).toBe("b1__soop");
  });

  it("prefers chzzk on a messageCount tie (PROVIDER_ORDER first)", () => {
    const chzzk = makeSession({ sessionId: "b1__chzzk", broadcastId: "b1", provider: "chzzk", messageCount: 5 });
    const soop = makeSession({ sessionId: "b1__soop", broadcastId: "b1", provider: "soop", messageCount: 5 });
    const [group] = groupSessionsByBroadcast([soop, chzzk]);

    expect(defaultSessionOf(group).provider).toBe("chzzk");
  });
});
