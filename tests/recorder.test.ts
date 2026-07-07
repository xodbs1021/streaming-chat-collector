import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ChatRecorder, buildSessionId, sanitizeFilePart } from "../src/server/recorder";
import { AppState, type AppSocketServer } from "../src/server/state";
import type { ChatMessage } from "../src/shared/types";

describe("chat recorder", () => {
  it("stores real chat messages as JSONL and updates session metadata", async () => {
    const dir = await makeTempDir();
    const recorder = new ChatRecorder(dir);
    const record = await recorder.recordMessage(makeMessage({ content: "안녕 분석", raw: { hello: "world" } }));

    expect(record?.sequence).toBe(1);
    const sessions = await recorder.listSessions();
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({ messageCount: 1, provider: "chzzk", channelId: "channel-1" });

    const fileContent = await readFile(path.join(dir, sessions[0].fileName), "utf8");
    expect(fileContent.trim()).toContain("\"content\":\"안녕 분석\"");

    const ended = await recorder.endSession();
    expect(ended?.endedAt).toBeGreaterThanOrEqual(ended?.startedAt ?? 0);
    await rm(dir, { recursive: true, force: true });
  });

  it("keeps a rename applied while the session is still recording", async () => {
    const dir = await makeTempDir();
    const recorder = new ChatRecorder(dir);

    const record = await recorder.recordMessage(makeMessage({ content: "첫 메시지" }));
    expect(record).toBeDefined();
    const sessionId = record?.sessionId as string;

    const renamed = await recorder.updateSessionMeta(sessionId, { displayName: "밴픽 연습 방송" });
    expect(renamed?.displayName).toBe("밴픽 연습 방송");

    // 이름 변경 후에도 채팅이 계속 들어오고, 세션이 종료(meta 재기록)돼도 이름이 유지돼야 한다
    await recorder.recordMessage(makeMessage({ messageId: "message-2", content: "둘째 메시지" }));
    const ended = await recorder.endSession();
    expect(ended?.displayName).toBe("밴픽 연습 방송");

    const session = await recorder.getSession(sessionId);
    expect(session?.displayName).toBe("밴픽 연습 방송");
    await rm(dir, { recursive: true, force: true });
  });

  it("stores, lists, and deletes timeline markers per session", async () => {
    const dir = await makeTempDir();
    const recorder = new ChatRecorder(dir);
    const record = await recorder.recordMessage(makeMessage({ content: "시작" }));
    const sessionId = record?.sessionId as string;

    const banpick = await recorder.writeMarker(sessionId, { timestamp: 1_000, label: "밴픽" });
    await recorder.writeMarker(sessionId, { timestamp: 5_000, label: "게임" });

    const markers = await recorder.readMarkers(sessionId);
    expect(markers.map((marker) => marker.label)).toEqual(["밴픽", "게임"]);
    expect(markers[0].timestamp).toBe(1_000);

    const deleted = await recorder.deleteMarker(sessionId, banpick.id);
    expect(deleted?.label).toBe("밴픽");
    expect((await recorder.readMarkers(sessionId)).map((marker) => marker.label)).toEqual(["게임"]);
    expect(await recorder.deleteMarker(sessionId, "없는-id")).toBeUndefined();
    await recorder.flushWrites();
    await rm(dir, { recursive: true, force: true });
  });

  it("skips mock messages", async () => {
    const dir = await makeTempDir();
    const recorder = new ChatRecorder(dir);
    const record = await recorder.recordMessage(makeMessage({ sourceMode: "mock" }));

    expect(record).toBeUndefined();
    expect(await recorder.listSessions()).toEqual([]);
    await rm(dir, { recursive: true, force: true });
  });

  it("keeps provider sessions separate while recording simultaneous chats", async () => {
    const dir = await makeTempDir();
    const recorder = new ChatRecorder(dir);

    await recorder.recordMessage(makeMessage({ messageId: "chzzk-1", channelId: "chzzk-channel" }));
    await recorder.recordMessage(
      makeMessage({
        provider: "soop",
        sourceMode: "unofficial",
        channelId: "soop-bj",
        messageId: "soop-1"
      })
    );

    const sessions = await recorder.listSessions();
    expect(sessions).toHaveLength(2);
    expect(sessions.map((session) => session.provider).sort()).toEqual(["chzzk", "soop"]);
    expect(recorder.getStatus().activeSessions).toHaveLength(2);
    expect(sessions.find((session) => session.provider === "chzzk")?.fileName).toContain("chzzk");
    expect(sessions.find((session) => session.provider === "soop")?.fileName).toContain("soop");
    await rm(dir, { recursive: true, force: true });
  });

  it("returns session list counts from readable JSONL records", async () => {
    const dir = await makeTempDir();
    const recorder = new ChatRecorder(dir);

    await recorder.recordMessage(makeMessage({ messageId: "message-1" }));
    const [session] = await recorder.listSessions();
    await writeFile(path.join(dir, `${session.sessionId}.meta.json`), `${JSON.stringify({ ...session, messageCount: 99 }, null, 2)}\n`);

    const [reconciledSession] = await recorder.listSessions();
    const directSession = await recorder.getSession(session.sessionId);

    expect(reconciledSession.messageCount).toBe(1);
    expect(directSession?.messageCount).toBe(1);
    await rm(dir, { recursive: true, force: true });
  });

  it("increments sequence numbers independently by provider", async () => {
    const dir = await makeTempDir();
    const recorder = new ChatRecorder(dir);

    const chzzkFirst = await recorder.recordMessage(makeMessage({ messageId: "chzzk-1" }));
    const soopFirst = await recorder.recordMessage(
      makeMessage({
        provider: "soop",
        sourceMode: "unofficial",
        channelId: "soop-bj",
        messageId: "soop-1"
      })
    );
    const chzzkSecond = await recorder.recordMessage(makeMessage({ messageId: "chzzk-2" }));

    expect(chzzkFirst?.sequence).toBe(1);
    expect(soopFirst?.sequence).toBe(1);
    expect(chzzkSecond?.sequence).toBe(2);
    await recorder.flushWrites();
    await rm(dir, { recursive: true, force: true });
  });

  it("ends only the requested provider session", async () => {
    const dir = await makeTempDir();
    const recorder = new ChatRecorder(dir);

    await recorder.recordMessage(makeMessage({ messageId: "chzzk-1" }));
    await recorder.recordMessage(
      makeMessage({
        provider: "soop",
        sourceMode: "unofficial",
        channelId: "soop-bj",
        messageId: "soop-1"
      })
    );

    const ended = await recorder.endSession("soop");
    const status = recorder.getStatus();

    expect(ended?.provider).toBe("soop");
    expect(status.activeSessions).toHaveLength(1);
    expect(status.activeSessions?.[0].provider).toBe("chzzk");
    expect(status.activeSession?.provider).toBe("chzzk");
    await rm(dir, { recursive: true, force: true });
  });

  it("falls back when raw cannot be serialized", async () => {
    const dir = await makeTempDir();
    const recorder = new ChatRecorder(dir);
    const circular: Record<string, unknown> = {};
    circular.self = circular;

    const record = await recorder.recordMessage(makeMessage({ raw: circular }));

    expect(record?.raw).toEqual({ serializationError: true });
    await rm(dir, { recursive: true, force: true });
  });

  it("persists highlight annotations per session", async () => {
    const dir = await makeTempDir();
    const recorder = new ChatRecorder(dir);

    const first = await recorder.writeHighlightAnnotation("session-1", "candidate-1", {
      category: "teamfight",
      note: "첫 한타",
      startAt: 1_720_000_000_000,
      endAt: 1_720_000_005_000,
      windowSec: 5,
      peakCount: 42,
      totalMessages: 70,
      topTerms: [{ label: "펜타킬", count: 12 }]
    });
    const second = await recorder.writeHighlightAnnotation("session-1", "candidate-1", {
      category: "pentakill",
      note: "펜타킬 구간"
    });

    const annotations = await recorder.readHighlightAnnotations("session-1");
    expect(annotations["candidate-1"]).toMatchObject({
      candidateId: "candidate-1",
      category: "pentakill",
      note: "펜타킬 구간",
      startAt: 1_720_000_000_000,
      endAt: 1_720_000_005_000,
      windowSec: 5,
      peakCount: 42,
      totalMessages: 70,
      topTerms: [{ label: "펜타킬", count: 12 }],
      createdAt: first.createdAt
    });
    expect(second.updatedAt).toBeGreaterThanOrEqual(first.updatedAt);
    await rm(dir, { recursive: true, force: true });
  });

  it("deletes highlight annotations per session", async () => {
    const dir = await makeTempDir();
    const recorder = new ChatRecorder(dir);

    await recorder.writeHighlightAnnotation("session-1", "candidate-1", {
      category: "teamfight",
      note: "삭제할 메모"
    });
    const deleted = await recorder.deleteHighlightAnnotation("session-1", "candidate-1");
    const annotations = await recorder.readHighlightAnnotations("session-1");

    expect(deleted?.candidateId).toBe("candidate-1");
    expect(annotations["candidate-1"]).toBeUndefined();
    await rm(dir, { recursive: true, force: true });
  });

  it("updates display names and hides archived sessions from the default list", async () => {
    const dir = await makeTempDir();
    const recorder = new ChatRecorder(dir);

    await recorder.recordMessage(makeMessage({ messageId: "session-meta-1" }));
    const [session] = await recorder.listSessions();
    const renamed = await recorder.updateSessionMeta(session.sessionId, { displayName: "LCK 하이라이트" });
    const archived = await recorder.archiveSession(session.sessionId);

    expect(renamed?.displayName).toBe("LCK 하이라이트");
    expect(archived?.archivedAt).toBeGreaterThanOrEqual(session.startedAt);
    expect(await recorder.listSessions()).toEqual([]);
    expect(await recorder.listSessions({ includeArchived: true })).toHaveLength(1);
    await rm(dir, { recursive: true, force: true });
  });

  it("uses safe session file names", () => {
    expect(sanitizeFilePart("../../이상한 채널!*")).toBe("unknown");
    expect(buildSessionId(1_720_000_000_000, "soop", "bj/id with space")).toMatch(/^\d{8}-\d{6}-soop-bj-id-with-space$/);
  });

  it("records messages through AppState.addMessage hook", async () => {
    const dir = await makeTempDir();
    const recorder = new ChatRecorder(dir);
    let pending: Promise<unknown> | undefined;
    const io = {
      emit: () => undefined,
      sockets: { sockets: new Map() }
    } as unknown as AppSocketServer;
    const state = new AppState(io, {
      onMessage: (message) => {
        pending = recorder.recordMessage(message);
      }
    });

    state.addMessage(makeMessage({ messageId: "integration-1" }));
    await pending;

    const sessions = await recorder.listSessions();
    const records = await recorder.readRecords(sessions[0].sessionId);
    expect(records[0]).toMatchObject({ messageId: "integration-1", sequence: 1 });
    await rm(dir, { recursive: true, force: true });
  });
});

async function makeTempDir() {
  return mkdtemp(path.join(tmpdir(), "chat-recorder-"));
}

function makeMessage(patch: Partial<ChatMessage> = {}): ChatMessage {
  return {
    provider: "chzzk",
    sourceMode: "official",
    channelId: "channel-1",
    messageId: "message-1",
    nickname: "테스터",
    role: "viewer",
    badges: [],
    content: "테스트 메시지",
    emotes: [],
    timestamp: 1_720_000_000_000,
    raw: {},
    ...patch
  };
}
