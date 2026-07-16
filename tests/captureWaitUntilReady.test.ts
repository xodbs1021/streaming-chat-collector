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

describe("FrameCaptureManager.start framesDir 주입", () => {
  async function makeManagerWith(ctorDir: string) {
    dirs.push(ctorDir);
    return new FrameCaptureManager(ctorDir, async () => "https://example.com/live.m3u8", () => undefined);
  }
  async function tmp(prefix: string) {
    const dir = await mkdtemp(path.join(tmpdir(), prefix));
    dirs.push(dir);
    return dir;
  }

  it("주입한 framesDir 기준으로 프레임 경로를 조립한다", async () => {
    const ctorDir = await tmp("cap-ctor-");
    const dirB = await tmp("cap-b-");
    const manager = await makeManagerWith(ctorDir);
    await manager.start("chan", dirB);
    expect(manager.framePath(5)).toBe(path.join(dirB, "5.jpg"));
    await manager.stop();
  });

  it("방송마다 재주입하면 대상 폴더가 바뀐다", async () => {
    const ctorDir = await tmp("cap-ctor-");
    const dirA = await tmp("cap-a-");
    const dirB = await tmp("cap-b-");
    const manager = await makeManagerWith(ctorDir);
    await manager.start("chan", dirA);
    expect(manager.framePath(1)).toBe(path.join(dirA, "1.jpg"));
    await manager.stop();
    await manager.start("chan", dirB);
    expect(manager.framePath(1)).toBe(path.join(dirB, "1.jpg"));
    await manager.stop();
  });

  it("framesDir 미주입 시 생성자 기본값을 유지한다 (기존 1-arg 호환)", async () => {
    const ctorDir = await tmp("cap-ctor-");
    const manager = await makeManagerWith(ctorDir);
    await manager.start("chan");
    expect(manager.framePath(9)).toBe(path.join(ctorDir, "9.jpg"));
    await manager.stop();
  });

  it("빈 채널 start는 framesDir를 바꾸지 않는다 (guard 앞 유지, no-op) [R4]", async () => {
    const ctorDir = await tmp("cap-ctor-");
    const dirB = await tmp("cap-b-");
    const manager = await makeManagerWith(ctorDir);
    await manager.start("", dirB);
    // 채널이 비어 guard가 즉시 반환 → dirB 주입되지 않음.
    expect(manager.framePath(3)).toBe(path.join(ctorDir, "3.jpg"));
    await manager.stop();
  });

  it("start는 방송 경계에서 프레임 인덱스를 비운다 (새 폴더 = frameCount 0)", async () => {
    const ctorDir = await tmp("cap-ctor-");
    const dirB = await tmp("cap-b-");
    const manager = await makeManagerWith(ctorDir);
    await manager.start("chan", dirB);
    expect(manager.getDebugState().frameCount).toBe(0);
    await manager.stop();
  });
});
