import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { finalizeBroadcastAlignment } from "../src/server/offset/finalizeAlignment";
import { estimateOffsetSegments } from "../src/server/offset/offsetEstimator";
import { BroadcastPaths } from "../src/server/broadcast/broadcastPaths";
import { createBroadcastId } from "../src/server/broadcast/broadcastId";
import type { ChatProvider, ChatRecord } from "../src/shared/types";

function makeRecord(provider: ChatProvider, timestamp: number, sequence: number): ChatRecord {
  return {
    provider,
    sourceMode: "unofficial",
    channelId: "ch",
    messageId: `${provider}-${sequence}`,
    nickname: "테스터",
    role: "viewer",
    badges: [],
    content: "안녕",
    emotes: [],
    timestamp,
    raw: {},
    sessionId: `bid__${provider}`,
    sequence,
    // receivedAt은 원본 수신 시각 보존 검증용 — anchor 축으로 바뀌면 안 된다.
    receivedAt: timestamp + 500
  };
}

function bursts(centersSec: number[], perBurst: number, startMs = 0): number[] {
  const times: number[] = [];
  for (const center of centersSec) {
    for (let i = 0; i < perBurst; i += 1) {
      times.push(startMs + center * 1000 + ((i * 37) % 1000));
    }
  }
  return times;
}

const CENTERS = [30, 95, 140, 220, 310, 400, 470, 550];

describe("finalizeBroadcastAlignment", () => {
  let root: string;
  let paths: BroadcastPaths;
  let broadcastId: string;

  async function writeChat(provider: ChatProvider, times: number[]) {
    const dir = paths.chatDir(broadcastId, provider);
    await mkdir(dir, { recursive: true });
    const lines = times.map((time, index) => JSON.stringify(makeRecord(provider, time, index + 1)));
    await writeFile(paths.chatFilePath(broadcastId, provider), `${lines.join("\n")}\n`, "utf8");
  }

  async function readRecords(provider: ChatProvider): Promise<ChatRecord[]> {
    const content = await readFile(paths.chatFilePath(broadcastId, provider), "utf8");
    return content
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line) as ChatRecord);
  }

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "finalize-align-"));
    paths = new BroadcastPaths(root);
    broadcastId = createBroadcastId();
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("SOOP chat.jsonl을 anchor 축으로 재작성하고 offset.json 마커를 남긴다", async () => {
    const chzzkTimes = bursts(CENTERS, 10);
    const soopTimes = chzzkTimes.map((time) => time + 8_000); // SOOP 8초 늦음
    await writeChat("chzzk", chzzkTimes);
    await writeChat("soop", soopTimes);

    const offset = await finalizeBroadcastAlignment(broadcastId, { paths });

    expect(offset).toBeDefined();
    expect(offset?.anchor).toBe("chzzk");
    expect(offset?.target).toBe("soop");
    expect(offset?.segments.length).toBeGreaterThanOrEqual(1);

    // 재작성 후 재추정 offset ≈ 0 (정렬 완료)
    const rewrittenSoop = await readRecords("soop");
    const chzzk = await readRecords("chzzk");
    const reEstimated = estimateOffsetSegments(
      chzzk.map((record) => record.timestamp),
      rewrittenSoop.map((record) => record.timestamp)
    );
    for (const segment of reEstimated) {
      expect(Math.abs(segment.offsetMs)).toBeLessThanOrEqual(1_000);
    }
  });

  it("재작성은 timestamp만 옮기고 sequence·receivedAt·라인 순서를 보존한다", async () => {
    const chzzkTimes = bursts(CENTERS, 10);
    const soopTimes = chzzkTimes.map((time) => time + 8_000);
    await writeChat("chzzk", chzzkTimes);
    await writeChat("soop", soopTimes);
    const before = await readRecords("soop");

    await finalizeBroadcastAlignment(broadcastId, { paths });
    const after = await readRecords("soop");

    expect(after.length).toBe(before.length);
    after.forEach((record, index) => {
      // 라인 순서 = messageId(=sequence 순) 그대로
      expect(record.messageId).toBe(before[index].messageId);
      expect(record.sequence).toBe(before[index].sequence);
      // receivedAt은 원본 그대로(anchor 축으로 이동 금지)
      expect(record.receivedAt).toBe(before[index].receivedAt);
      // timestamp는 ~8초 앞으로 당겨졌다
      expect(record.timestamp).toBeLessThan(before[index].timestamp);
    });
  });

  it("offset.json이 이미 있으면 재적용하지 않는다(멱등 가드)", async () => {
    const chzzkTimes = bursts(CENTERS, 10);
    const soopTimes = chzzkTimes.map((time) => time + 8_000);
    await writeChat("chzzk", chzzkTimes);
    await writeChat("soop", soopTimes);

    await finalizeBroadcastAlignment(broadcastId, { paths });
    const afterFirst = await readFile(paths.chatFilePath(broadcastId, "soop"), "utf8");

    const second = await finalizeBroadcastAlignment(broadcastId, { paths });
    const afterSecond = await readFile(paths.chatFilePath(broadcastId, "soop"), "utf8");

    expect(second).toBeDefined(); // 기존 마커를 돌려준다
    expect(afterSecond).toBe(afterFirst); // 두 번째는 재작성하지 않음(바이트 동일)
  });

  it("정렬 불가(SOOP 없음)면 마커를 안 남기고 chzzk도 건드리지 않는다", async () => {
    const chzzkTimes = bursts(CENTERS, 10);
    await writeChat("chzzk", chzzkTimes);
    const before = await readFile(paths.chatFilePath(broadcastId, "chzzk"), "utf8");

    const offset = await finalizeBroadcastAlignment(broadcastId, { paths });

    expect(offset).toBeUndefined();
    await expect(readFile(paths.offsetFilePath(broadcastId), "utf8")).rejects.toThrow();
    expect(await readFile(paths.chatFilePath(broadcastId, "chzzk"), "utf8")).toBe(before);
  });
});
