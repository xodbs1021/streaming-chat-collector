import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { registerBroadcastRoutes } from "../src/server/routes/broadcasts";
import { ChatRecorder } from "../src/server/recorder";
import { BroadcastPaths } from "../src/server/broadcast/broadcastPaths";
import { createBroadcastId } from "../src/server/broadcast/broadcastId";
import type { AnalyticsSummary, BroadcastOffset, ChatProvider, ChatRecord, HighlightSummary } from "../src/shared/types";

function makeRecord(provider: ChatProvider, timestamp: number, sequence: number): ChatRecord {
  return {
    provider,
    sourceMode: "unofficial",
    channelId: "ch",
    messageId: `${provider}-${sequence}`,
    nickname: `${provider}-user`,
    role: "viewer",
    badges: [],
    content: "안녕 하이라이트",
    emotes: [],
    timestamp,
    raw: {},
    sessionId: `bid__${provider}`,
    sequence,
    receivedAt: timestamp
  };
}

describe("병합 조회 라우트 (/api/broadcasts/:id merge)", () => {
  let app: FastifyInstance;
  let root: string;
  let paths: BroadcastPaths;
  let broadcastId: string;

  async function writeChat(provider: ChatProvider, times: number[]) {
    const dir = paths.chatDir(broadcastId, provider);
    await mkdir(dir, { recursive: true });
    const lines = times.map((time, index) => JSON.stringify(makeRecord(provider, time, index + 1)));
    await writeFile(paths.chatFilePath(broadcastId, provider), `${lines.join("\n")}\n`, "utf8");
  }

  beforeAll(async () => {
    root = await mkdtemp(path.join(tmpdir(), "merge-routes-"));
    paths = new BroadcastPaths(root);
    broadcastId = createBroadcastId();
    // 파일은 이미 정렬됐다고 가정(단순 concat 대상) — chzzk·soop 각각 채팅을 쓴다.
    await writeChat("chzzk", [1_000, 2_000, 3_000, 10_000]);
    await writeChat("soop", [1_500, 2_500, 11_000, 12_000]);

    app = Fastify();
    registerBroadcastRoutes(app, { recorder: new ChatRecorder(root), paths });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    await rm(root, { recursive: true, force: true });
  });

  it("windows 200: 양 provider 채팅을 합쳐 요약한다(totalMessages=8, providerCounts 양쪽)", async () => {
    const response = await app.inject({ url: `/api/broadcasts/${broadcastId}/windows?windowSec=5` });
    expect(response.statusCode).toBe(200);
    const summary = response.json() as AnalyticsSummary;
    expect(summary.totalMessages).toBe(8);
    expect(summary.providerCounts.chzzk).toBe(4);
    expect(summary.providerCounts.soop).toBe(4);
    expect(summary.windowSec).toBe(5);
  });

  it("highlights 200: 병합 채팅으로 후보를 계산하고 저장은 막는다(읽기 전용)", async () => {
    const response = await app.inject({ url: `/api/broadcasts/${broadcastId}/highlights?windowSec=1` });
    expect(response.statusCode).toBe(200);
    const summary = response.json() as HighlightSummary;
    expect(summary.canSaveAnnotations).toBe(false);
  });

  it("windows 400: 형식 불량 broadcastId(traversal 시도)를 거부한다", async () => {
    const response = await app.inject({ url: "/api/broadcasts/..%2F..%2Fetc/windows" });
    expect(response.statusCode).toBe(400);
  });

  it("windows 404: 채팅이 없는(형식은 유효한) broadcastId", async () => {
    const response = await app.inject({ url: `/api/broadcasts/${createBroadcastId()}/windows` });
    expect(response.statusCode).toBe(404);
  });

  it("offset 404: offset.json 마커가 없으면 '보정 기록 없음'", async () => {
    const response = await app.inject({ url: `/api/broadcasts/${broadcastId}/offset` });
    expect(response.statusCode).toBe(404);
  });

  it("windows 200: 단일 provider 방송도 그 provider만으로 요약한다", async () => {
    const soloId = createBroadcastId();
    const dir = paths.chatDir(soloId, "chzzk");
    await mkdir(dir, { recursive: true });
    const lines = [1_000, 2_000, 3_000].map((time, index) => JSON.stringify(makeRecord("chzzk", time, index + 1)));
    await writeFile(paths.chatFilePath(soloId, "chzzk"), `${lines.join("\n")}\n`, "utf8");

    const response = await app.inject({ url: `/api/broadcasts/${soloId}/windows?windowSec=5` });
    expect(response.statusCode).toBe(200);
    const summary = response.json() as AnalyticsSummary;
    expect(summary.totalMessages).toBe(3);
    expect(summary.providerCounts.chzzk).toBe(3);
    expect(summary.providerCounts.soop).toBeUndefined();
  });

  it("highlights 400: 형식 불량 broadcastId를 거부한다", async () => {
    const response = await app.inject({ url: "/api/broadcasts/..%2F..%2Fetc/highlights" });
    expect(response.statusCode).toBe(400);
  });

  it("offset 400: 형식 불량 broadcastId를 거부한다", async () => {
    const response = await app.inject({ url: "/api/broadcasts/..%2F..%2Fetc/offset" });
    expect(response.statusCode).toBe(400);
  });

  it("offset 200: offset.json 마커를 그대로 반환한다", async () => {
    const marker: BroadcastOffset = {
      version: 1,
      anchor: "chzzk",
      target: "soop",
      computedAt: 123,
      params: { windowSec: 600, binSec: 1, searchSec: 60, reestimateSec: 60 },
      segments: [{ startAt: 0, endAt: 600_000, offsetMs: -8_000, confidence: 0.7, carried: false }]
    };
    await writeFile(paths.offsetFilePath(broadcastId), JSON.stringify(marker), "utf8");

    const response = await app.inject({ url: `/api/broadcasts/${broadcastId}/offset` });
    expect(response.statusCode).toBe(200);
    expect((response.json() as BroadcastOffset).segments[0].offsetMs).toBe(-8_000);
  });
});
