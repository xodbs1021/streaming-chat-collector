import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { registerAnalyticsRoutes } from "../src/server/routes/analytics";
import { LiveAnalytics } from "../src/server/analytics";
import { finalizeBroadcastAlignment } from "../src/server/offset/finalizeAlignment";
import { ChatRecorder } from "../src/server/recorder";
import { BroadcastPaths } from "../src/server/broadcast/broadcastPaths";
import { createBroadcastId } from "../src/server/broadcast/broadcastId";
import { composeSessionKey } from "../src/server/broadcast/sessionKey";
import type { AppSocketServer } from "../src/server/state";
import type { ChatProvider, ChatRecord, RecordingSession } from "../src/shared/types";

/**
 * plan-reviewer #2 고정 테스트: finalize가 SOOP chat.jsonl을 anchor 축으로 재작성하면,
 * SOOP 세션 export의 relative(timestamp − startedAt)도 그만큼 이동한다("SOOP export 시각은 anchor 축").
 * 기존 export shape/로직은 무변경 — 현 동작을 못 박아 무심결 회귀를 막는다.
 */

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
    sessionId: composeSessionKey("bid", provider),
    sequence,
    receivedAt: timestamp
  };
}

function bursts(centersSec: number[], perBurst: number, startMs: number): number[] {
  const times: number[] = [];
  for (const center of centersSec) {
    for (let i = 0; i < perBurst; i += 1) {
      times.push(startMs + center * 1000 + ((i * 37) % 1000));
    }
  }
  return times;
}

const CENTERS = [30, 95, 140, 220, 310, 400, 470, 550];

describe("SOOP export 축 — finalize 재작성 후 anchor 축으로 이동(고정)", () => {
  let app: FastifyInstance;
  let root: string;
  let paths: BroadcastPaths;
  let broadcastId: string;
  let soopSessionId: string;
  let startedAt: number;

  function firstRelative(csv: string): string {
    // ﻿ BOM + header + 첫 레코드 행. relative는 두 번째 컬럼.
    const lines = csv.replace(/^﻿/, "").split("\n");
    return lines[1].split(",")[1];
  }

  beforeAll(async () => {
    root = await mkdtemp(path.join(tmpdir(), "soop-export-axis-"));
    paths = new BroadcastPaths(root);
    broadcastId = createBroadcastId();
    soopSessionId = composeSessionKey(broadcastId, "soop");

    const chzzkTimes = bursts(CENTERS, 10, 0);
    const soopTimes = chzzkTimes.map((time) => time + 8_000); // SOOP 8초 늦음
    startedAt = soopTimes[0]; // 첫 SOOP 레코드 원본 시각 = 세션 시작

    for (const provider of ["chzzk", "soop"] as const) {
      const times = provider === "chzzk" ? chzzkTimes : soopTimes;
      await mkdir(paths.chatDir(broadcastId, provider), { recursive: true });
      const lines = times.map((time, index) => JSON.stringify(makeRecord(provider, time, index + 1)));
      await writeFile(paths.chatFilePath(broadcastId, provider), `${lines.join("\n")}\n`, "utf8");
    }
    // SOOP 세션 meta — export가 getSession으로 읽는다(startedAt 포함).
    const soopMeta: RecordingSession = {
      sessionId: soopSessionId,
      broadcastId,
      provider: "soop",
      sourceMode: "unofficial",
      channelId: "ch",
      startedAt,
      messageCount: soopTimes.length,
      fileName: "chat/soop/chat.jsonl"
    };
    await writeFile(paths.metaFilePath(broadcastId, "soop"), JSON.stringify(soopMeta), "utf8");

    app = Fastify();
    registerAnalyticsRoutes(app, { recorder: new ChatRecorder(root), liveAnalytics: new LiveAnalytics(), io: {} as AppSocketServer });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    await rm(root, { recursive: true, force: true });
  });

  it("재작성 전에는 첫 SOOP 레코드 relative가 0:00:00이다", async () => {
    const response = await app.inject({ url: `/api/analytics/sessions/${encodeURIComponent(soopSessionId)}/export?format=csv` });
    expect(response.statusCode).toBe(200);
    expect(firstRelative(response.body)).toBe("0:00:00");
  });

  it("finalize 재작성 후 첫 레코드는 anchor 축으로 startedAt 이전이 되어 relative가 드랍된다(기존 음수 가드)", async () => {
    await finalizeBroadcastAlignment(broadcastId, { paths });

    const response = await app.inject({ url: `/api/analytics/sessions/${encodeURIComponent(soopSessionId)}/export?format=csv` });
    // anchor(≈30초) < startedAt(38초) → 음수라 기존 가드가 relative를 빈 값으로 둔다.
    expect(firstRelative(response.body)).toBe("");
  });
});
