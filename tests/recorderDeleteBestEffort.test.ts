import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatRecorder } from "../src/server/recorder";
import type { BroadcastProviderRef, ChatMessage } from "../src/shared/types";

// 빈 방송 폴더(husk) 정리 rm만 선택적으로 실패시키기 위해 fs/promises를 spy로 감싼다.
// recorder.test.ts(실 fs)와 분리된 별파일 — mock이 다른 테스트에 새지 않게 격리한다.
vi.mock("node:fs/promises", { spy: true });

const actualFs = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");

describe("chat recorder — 빈 방송 폴더 정리는 베스트 에포트", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("husk 정리 rm이 실패해도 deleted를 반환하고 frame·chat은 실제로 지워진다", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "chat-recorder-besteffort-"));
    const recorder = new ChatRecorder(dir);
    const broadcast = await recorder.startRecording([chzzkRef()]);
    await recorder.recordMessage(makeMessage());
    await recorder.flushWrites();
    await recorder.stopRecording();
    const broadcastDir = path.join(dir, broadcast!.broadcastId);
    const frameDir = path.join(broadcastDir, "frame", "chzzk");
    await mkdir(frameDir, { recursive: true });
    await writeFile(path.join(frameDir, "100.jpg"), "frame:100");

    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    // 방송 폴더 rm만 실패 — frame/chat rm은 실제 fs로 위임한다.
    vi.mocked(rm).mockImplementation(async (target, options) => {
      if (String(target) === broadcastDir) {
        throw new Error("rm 실패(권한)");
      }
      return actualFs.rm(target, options);
    });

    await expect(recorder.deleteSession(`${broadcast!.broadcastId}__chzzk`)).resolves.toBe("deleted");
    await expect(actualFs.stat(frameDir)).rejects.toThrow();
    await expect(actualFs.stat(path.join(broadcastDir, "chat", "chzzk"))).rejects.toThrow();
    await expect(actualFs.stat(broadcastDir)).resolves.toBeTruthy(); // husk는 남는다 — 무해한 잔여물
    expect(consoleError).toHaveBeenCalled(); // 삼키되 로그는 남긴다

    await actualFs.rm(dir, { recursive: true, force: true });
  });

  it("meta 확인 stat이 ENOENT 아닌 오류(EIO)를 내면 방송 폴더를 지우지 않는다(보수 판정)", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "chat-recorder-besteffort-"));
    const recorder = new ChatRecorder(dir);
    const broadcast = await recorder.startRecording([chzzkRef()]);
    await recorder.recordMessage(makeMessage());
    await recorder.flushWrites();
    await recorder.stopRecording();
    const broadcastDir = path.join(dir, broadcast!.broadcastId);

    // provider meta 경로의 stat만 일시 오류(EIO) — "없음"이 확인된 게 아니므로 husk 정리가 나서면 안 된다.
    const providerMetaPaths = new Set([
      path.join(broadcastDir, "chat", "chzzk", "meta.json"),
      path.join(broadcastDir, "chat", "soop", "meta.json")
    ]);
    vi.mocked(stat).mockImplementation(async (target) => {
      if (providerMetaPaths.has(String(target))) {
        throw Object.assign(new Error("EIO: i/o error, stat"), { code: "EIO" });
      }
      return actualFs.stat(target);
    });

    await expect(recorder.deleteSession(`${broadcast!.broadcastId}__chzzk`)).resolves.toBe("deleted");
    await expect(actualFs.stat(path.join(broadcastDir, "chat", "chzzk"))).rejects.toThrow(); // chat은 지워졌다
    await expect(actualFs.stat(broadcastDir)).resolves.toBeTruthy(); // 방송 폴더는 보존(오판 방지)
    expect(vi.mocked(rm).mock.calls.some(([target]) => String(target) === broadcastDir)).toBe(false);

    await actualFs.rm(dir, { recursive: true, force: true });
  });
});

function chzzkRef(): BroadcastProviderRef {
  return { provider: "chzzk", sourceMode: "official", channelId: "channel-1" };
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
