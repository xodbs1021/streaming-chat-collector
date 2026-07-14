import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ChatRecorder } from "../src/server/recorder";
import { AppState, type AppSocketServer } from "../src/server/state";
import type { BroadcastProviderRef, ChatMessage } from "../src/shared/types";

describe("chat recorder — 방송 라이프사이클", () => {
  it("녹화 시작 전에는 저장하지 않지만 라이브 분석용 record는 반환한다", async () => {
    const dir = await makeTempDir();
    const recorder = new ChatRecorder(dir);

    const record = await recorder.recordMessage(makeMessage({ content: "연결만" }));

    expect(record?.messageId).toBe("message-1"); // 라이브 분석용으로 반환
    expect(record?.sessionId).toBe(""); // 비녹화 → 세션 없음
    expect(recorder.isRecording()).toBe(false);
    expect(await recorder.listSessions()).toEqual([]); // 디스크에 아무것도 없음
    await rm(dir, { recursive: true, force: true });
  });

  it("녹화 시작 후 메시지를 nested 레이아웃으로 저장한다", async () => {
    const dir = await makeTempDir();
    const recorder = new ChatRecorder(dir);

    const broadcast = await recorder.startRecording([chzzkRef()]);
    expect(broadcast?.broadcastId).toMatch(/^\d{8}-\d{6}-[0-9a-f]{6}$/);

    const record = await recorder.recordMessage(makeMessage({ content: "안녕 분석" }));
    expect(record?.sequence).toBe(1);
    expect(record?.sessionId).toBe(`${broadcast?.broadcastId}__chzzk`);

    await recorder.flushWrites();
    const chatPath = path.join(dir, broadcast!.broadcastId, "chat", "chzzk", "chat.jsonl");
    expect(await readFile(chatPath, "utf8")).toContain('"content":"안녕 분석"');

    const sessions = await recorder.listSessions();
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({ broadcastId: broadcast?.broadcastId, provider: "chzzk", messageCount: 1 });
    await rm(dir, { recursive: true, force: true });
  });

  it("chzzk+soop를 하나의 broadcastId 아래 각 provider 세션으로 묶는다", async () => {
    const dir = await makeTempDir();
    const recorder = new ChatRecorder(dir);
    const broadcast = await recorder.startRecording([chzzkRef(), soopRef()]);

    await recorder.recordMessage(makeMessage({ messageId: "chzzk-1" }));
    await recorder.recordMessage(
      makeMessage({ provider: "soop", sourceMode: "unofficial", channelId: "soop-bj", messageId: "soop-1" })
    );

    const sessions = await recorder.listSessions();
    expect(sessions).toHaveLength(2);
    expect(sessions.every((session) => session.broadcastId === broadcast?.broadcastId)).toBe(true);
    expect(sessions.map((session) => session.provider).sort()).toEqual(["chzzk", "soop"]);
    expect(recorder.getStatus().activeSessions).toHaveLength(2);
    await recorder.flushWrites();
    await rm(dir, { recursive: true, force: true });
  });

  it("provider별 sequence는 독립적으로 증가하고 녹화 시작 시 1부터다", async () => {
    const dir = await makeTempDir();
    const recorder = new ChatRecorder(dir);
    await recorder.startRecording([chzzkRef(), soopRef()]);

    const chzzk1 = await recorder.recordMessage(makeMessage({ messageId: "chzzk-1" }));
    const soop1 = await recorder.recordMessage(
      makeMessage({ provider: "soop", sourceMode: "unofficial", channelId: "soop-bj", messageId: "soop-1" })
    );
    const chzzk2 = await recorder.recordMessage(makeMessage({ messageId: "chzzk-2" }));

    expect(chzzk1?.sequence).toBe(1);
    expect(soop1?.sequence).toBe(1);
    expect(chzzk2?.sequence).toBe(2);
    await recorder.flushWrites();
    await rm(dir, { recursive: true, force: true });
  });

  it("녹화 중 뒤늦게 연결된 provider도 방송에 합류한다", async () => {
    const dir = await makeTempDir();
    const recorder = new ChatRecorder(dir);
    const broadcast = await recorder.startRecording([chzzkRef()]);

    await recorder.recordMessage(
      makeMessage({ provider: "soop", sourceMode: "unofficial", channelId: "soop-bj", messageId: "soop-late" })
    );
    await recorder.flushWrites();

    const sessions = await recorder.listSessions();
    expect(sessions.map((session) => session.provider).sort()).toEqual(["chzzk", "soop"]);
    expect(sessions.every((session) => session.broadcastId === broadcast?.broadcastId)).toBe(true);
    await rm(dir, { recursive: true, force: true });
  });

  it("녹화 종료 시 방송·provider 메타에 endedAt을 기록한다", async () => {
    const dir = await makeTempDir();
    const recorder = new ChatRecorder(dir);
    const broadcast = await recorder.startRecording([chzzkRef()]);
    await recorder.recordMessage(makeMessage({ content: "첫 메시지" }));

    const ended = await recorder.stopRecording();
    expect(ended?.broadcastId).toBe(broadcast?.broadcastId);
    expect(ended?.endedAt).toBeGreaterThanOrEqual(ended?.startedAt ?? 0);
    expect(recorder.isRecording()).toBe(false);

    const broadcastMeta = JSON.parse(
      await readFile(path.join(dir, broadcast!.broadcastId, "broadcast.meta.json"), "utf8")
    );
    expect(broadcastMeta.endedAt).toBeGreaterThan(0);
    const providerMeta = JSON.parse(
      await readFile(path.join(dir, broadcast!.broadcastId, "chat", "chzzk", "meta.json"), "utf8")
    );
    expect(providerMeta.endedAt).toBeGreaterThan(0);
    await rm(dir, { recursive: true, force: true });
  });

  it("provider가 없으면 녹화를 시작하지 않는다", async () => {
    const dir = await makeTempDir();
    const recorder = new ChatRecorder(dir);
    expect(await recorder.startRecording([])).toBeUndefined();
    expect(recorder.isRecording()).toBe(false);
    await rm(dir, { recursive: true, force: true });
  });

  it("mock 메시지는 무시한다", async () => {
    const dir = await makeTempDir();
    const recorder = new ChatRecorder(dir);
    await recorder.startRecording([chzzkRef()]);
    const record = await recorder.recordMessage(makeMessage({ sourceMode: "mock" }));
    expect(record).toBeUndefined();
    await recorder.flushWrites();
    expect((await recorder.listSessions())[0]?.messageCount ?? 0).toBe(0);
    await rm(dir, { recursive: true, force: true });
  });

  it("녹화 중 이름 변경이 종료 후에도 유지된다", async () => {
    const dir = await makeTempDir();
    const recorder = new ChatRecorder(dir);
    await recorder.startRecording([chzzkRef()]);
    const record = await recorder.recordMessage(makeMessage({ content: "첫 메시지" }));
    const sessionId = record!.sessionId;

    const renamed = await recorder.updateSessionMeta(sessionId, { displayName: "밴픽 연습 방송" });
    expect(renamed?.displayName).toBe("밴픽 연습 방송");

    await recorder.recordMessage(makeMessage({ messageId: "message-2", content: "둘째" }));
    await recorder.stopRecording();
    const session = await recorder.getSession(sessionId);
    expect(session?.displayName).toBe("밴픽 연습 방송");
    await rm(dir, { recursive: true, force: true });
  });

  it("세션별 타임라인 마커를 저장·조회·삭제한다", async () => {
    const dir = await makeTempDir();
    const recorder = new ChatRecorder(dir);
    await recorder.startRecording([chzzkRef()]);
    const record = await recorder.recordMessage(makeMessage({ content: "시작" }));
    const sessionId = record!.sessionId;

    const banpick = await recorder.writeMarker(sessionId, { timestamp: 1_000, label: "밴픽" });
    await recorder.writeMarker(sessionId, { timestamp: 5_000, label: "게임" });
    expect((await recorder.readMarkers(sessionId)).map((marker) => marker.label)).toEqual(["밴픽", "게임"]);
    await recorder.deleteMarker(sessionId, banpick.id);
    expect((await recorder.readMarkers(sessionId)).map((marker) => marker.label)).toEqual(["게임"]);
    await recorder.flushWrites();
    await rm(dir, { recursive: true, force: true });
  });

  it("하이라이트 주석을 세션별로 저장·삭제한다", async () => {
    const dir = await makeTempDir();
    const recorder = new ChatRecorder(dir);
    const broadcast = await recorder.startRecording([chzzkRef()]);
    const sessionId = `${broadcast!.broadcastId}__chzzk`;

    const first = await recorder.writeHighlightAnnotation(sessionId, "candidate-1", { category: "teamfight", note: "첫 한타" });
    const second = await recorder.writeHighlightAnnotation(sessionId, "candidate-1", { category: "pentakill" });
    const annotations = await recorder.readHighlightAnnotations(sessionId);
    expect(annotations["candidate-1"]).toMatchObject({ category: "pentakill", note: "첫 한타", createdAt: first.createdAt });
    expect(second.updatedAt).toBeGreaterThanOrEqual(first.updatedAt);

    const deleted = await recorder.deleteHighlightAnnotation(sessionId, "candidate-1");
    expect(deleted?.candidateId).toBe("candidate-1");
    expect((await recorder.readHighlightAnnotations(sessionId))["candidate-1"]).toBeUndefined();
    await rm(dir, { recursive: true, force: true });
  });

  it("아카이브한 세션은 기본 목록에서 숨는다", async () => {
    const dir = await makeTempDir();
    const recorder = new ChatRecorder(dir);
    await recorder.startRecording([chzzkRef()]);
    await recorder.recordMessage(makeMessage({ messageId: "s-1" }));
    const [session] = await recorder.listSessions();
    await recorder.archiveSession(session.sessionId);
    expect(await recorder.listSessions()).toEqual([]);
    expect(await recorder.listSessions({ includeArchived: true })).toHaveLength(1);
    await recorder.flushWrites();
    await rm(dir, { recursive: true, force: true });
  });

  it("시청자 표본은 녹화 중에만 저장된다", async () => {
    const dir = await makeTempDir();
    const recorder = new ChatRecorder(dir);
    await recorder.recordViewerSample("chzzk", 100); // 비녹화 → 무시
    const broadcast = await recorder.startRecording([chzzkRef()]);
    await recorder.recordViewerSample("chzzk", 250);
    await recorder.flushWrites();

    const samples = await recorder.readViewerSamples(`${broadcast!.broadcastId}__chzzk`);
    expect(samples).toHaveLength(1);
    expect(samples[0].count).toBe(250);
    await rm(dir, { recursive: true, force: true });
  });

  it("AppState.addMessage 훅으로 녹화 중 메시지를 저장한다", async () => {
    const dir = await makeTempDir();
    const recorder = new ChatRecorder(dir);
    await recorder.startRecording([chzzkRef()]);
    let pending: Promise<unknown> | undefined;
    const io = { emit: () => undefined, sockets: { sockets: new Map() } } as unknown as AppSocketServer;
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

  it("직렬화 불가한 raw는 안전하게 대체한다", async () => {
    const dir = await makeTempDir();
    const recorder = new ChatRecorder(dir);
    await recorder.startRecording([chzzkRef()]);
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const record = await recorder.recordMessage(makeMessage({ raw: circular }));
    expect(record?.raw).toEqual({ serializationError: true });
    await recorder.flushWrites();
    await rm(dir, { recursive: true, force: true });
  });
});

async function makeTempDir() {
  return mkdtemp(path.join(tmpdir(), "chat-recorder-"));
}

function chzzkRef(): BroadcastProviderRef {
  return { provider: "chzzk", sourceMode: "official", channelId: "channel-1" };
}

function soopRef(): BroadcastProviderRef {
  return { provider: "soop", sourceMode: "unofficial", channelId: "soop-bj" };
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
