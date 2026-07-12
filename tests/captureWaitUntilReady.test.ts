import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

// spawn을 가짜 child로 대체해 실제 ffmpeg 없이 "capturing" 상태를 관측한다.
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  const events = await import("node:events");
  class FakeChild extends events.EventEmitter {
    stderr = new events.EventEmitter();
    kill() {
      setImmediate(() => this.emit("exit", 0));
      return true;
    }
  }
  return { ...actual, spawn: () => new FakeChild() };
});

// mock 이후에 import해야 매니저가 가짜 spawn을 집는다.
const { FrameCaptureManager } = await import("../src/server/frameCapture");

const dirs: string[] = [];
async function makeManager() {
  const framesDir = await mkdtemp(path.join(tmpdir(), "cap-wait-"));
  dirs.push(framesDir);
  return new FrameCaptureManager(framesDir, async () => "https://example.com/live.m3u8", () => undefined);
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("FrameCaptureManager.waitUntilReady", () => {
  it("resolves to ready once a capturing child is observed", async () => {
    const manager = await makeManager();
    await manager.start("chan-1");
    expect(await manager.waitUntilReady(1_000, () => false)).toBe("ready");
    await manager.stop();
  });

  it("returns cancelled when the token trips, even though the child is capturing [B1]", async () => {
    const manager = await makeManager();
    await manager.start("chan-1");
    // 새 시퀀스가 진입한 것을 흉내 — capturing=true여도 취소가 우선해야 한다
    expect(await manager.waitUntilReady(1_000, () => true)).toBe("cancelled");
    await manager.stop();
  });
});
