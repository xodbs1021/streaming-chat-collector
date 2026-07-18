import { mkdir, mkdtemp, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { BroadcastFrameReader } from "../src/server/broadcast/broadcastFrameReader";
import { BroadcastPaths } from "../src/server/broadcast/broadcastPaths";
import { createBroadcastId } from "../src/server/broadcast/broadcastId";

// mtime 캐시 검증(readdir 호출 수 카운트)을 위해 fs/promises 전체를 spy로 감싼다 — 실제 동작은 위임된다.
vi.mock("node:fs/promises", { spy: true });

describe("BroadcastFrameReader", () => {
  it("구간 필터링 + 오름차순 정렬", async () => {
    const root = await makeTempRoot();
    const broadcastId = createBroadcastId();
    await makeFrameFixture(root, broadcastId, "chzzk", ["110.jpg", "100.jpg", "105.jpg"]);
    const reader = new BroadcastFrameReader(new BroadcastPaths(root));

    expect(await reader.listFrameSeconds(broadcastId, "chzzk", 103, 111)).toEqual([105, 110]);
    await rm(root, { recursive: true, force: true });
  });

  it("프레임 아닌 파일 무시", async () => {
    const root = await makeTempRoot();
    const broadcastId = createBroadcastId();
    await makeFrameFixture(root, broadcastId, "chzzk", ["100.jpg", ".DS_Store", "abc.jpg"]);
    const reader = new BroadcastFrameReader(new BroadcastPaths(root));

    expect(await reader.listFrameSeconds(broadcastId, "chzzk", 0, Number.MAX_SAFE_INTEGER)).toEqual([100]);
    await rm(root, { recursive: true, force: true });
  });

  it("폴더 없음 → []", async () => {
    const root = await makeTempRoot();
    const reader = new BroadcastFrameReader(new BroadcastPaths(root));

    expect(await reader.listFrameSeconds(createBroadcastId(), "chzzk", 0, Number.MAX_SAFE_INTEGER)).toEqual([]);
    await rm(root, { recursive: true, force: true });
  });

  it("형식 불량 broadcastId → [] (경로 조립 자체를 안 함)", async () => {
    const root = await makeTempRoot();
    const reader = new BroadcastFrameReader(new BroadcastPaths(root));

    expect(await reader.listFrameSeconds("../../etc", "chzzk", 0, Number.MAX_SAFE_INTEGER)).toEqual([]);
    expect(await reader.nearestFramePath("../../etc", "chzzk", 100)).toBeUndefined();
    await rm(root, { recursive: true, force: true });
  });

  it("nearestFramePath: second 이하 최근접 경로", async () => {
    const root = await makeTempRoot();
    const broadcastId = createBroadcastId();
    const frameDir = await makeFrameFixture(root, broadcastId, "soop", ["100.jpg"]);
    const reader = new BroadcastFrameReader(new BroadcastPaths(root));

    expect(await reader.nearestFramePath(broadcastId, "soop", 110)).toBe(path.join(frameDir, "100.jpg"));
    await rm(root, { recursive: true, force: true });
  });

  it("nearestFramePath: tolerance 15초 초과 → undefined", async () => {
    const root = await makeTempRoot();
    const broadcastId = createBroadcastId();
    await makeFrameFixture(root, broadcastId, "soop", ["100.jpg"]);
    const reader = new BroadcastFrameReader(new BroadcastPaths(root));

    expect(await reader.nearestFramePath(broadcastId, "soop", 116)).toBeUndefined();
    await rm(root, { recursive: true, force: true });
  });

  it("mtime 캐시: 폴더 불변이면 readdir 1회, mtime이 바뀌면 재구축한다", async () => {
    const root = await makeTempRoot();
    const broadcastId = createBroadcastId();
    const frameDir = await makeFrameFixture(root, broadcastId, "chzzk", ["100.jpg"]);
    const reader = new BroadcastFrameReader(new BroadcastPaths(root));

    // fixture 생성 코드가 남긴 호출 카운트를 지워 조회분만 격리한다.
    vi.clearAllMocks();
    expect(await reader.listFrameSeconds(broadcastId, "chzzk", 0, Number.MAX_SAFE_INTEGER)).toEqual([100]);
    expect(await reader.listFrameSeconds(broadcastId, "chzzk", 0, Number.MAX_SAFE_INTEGER)).toEqual([100]);
    expect(vi.mocked(readdir).mock.calls.length).toBe(1);

    // 파일 추가 후 mtime을 명시적으로 밀어(파일시스템 시간 해상도 플레이크 방지) 재구축을 유도한다.
    await writeFile(path.join(frameDir, "105.jpg"), "frame:105.jpg");
    const dirStat = await stat(frameDir);
    await utimes(frameDir, new Date(), new Date(dirStat.mtimeMs + 2_000));
    expect(await reader.listFrameSeconds(broadcastId, "chzzk", 0, Number.MAX_SAFE_INTEGER)).toEqual([100, 105]);
    await rm(root, { recursive: true, force: true });
  });

  it("readdir이 실패해도(레이스: stat 직후 폴더 삭제) throw 없이 []로 자기 치유한다", async () => {
    const root = await makeTempRoot();
    const broadcastId = createBroadcastId();
    await makeFrameFixture(root, broadcastId, "chzzk", ["100.jpg"]);
    const reader = new BroadcastFrameReader(new BroadcastPaths(root));

    vi.mocked(readdir).mockRejectedValueOnce(Object.assign(new Error("ENOENT: no such directory"), { code: "ENOENT" }));
    expect(await reader.listFrameSeconds(broadcastId, "chzzk", 0, Number.MAX_SAFE_INTEGER)).toEqual([]);
    // 다음 조회는 실제 fs로 정상 복구된다(캐시 엔트리 제거 후 재구축).
    expect(await reader.listFrameSeconds(broadcastId, "chzzk", 0, Number.MAX_SAFE_INTEGER)).toEqual([100]);
    await rm(root, { recursive: true, force: true });
  });

  it("삭제 자기 치유: 조회 후 폴더가 사라지면 재조회는 []", async () => {
    const root = await makeTempRoot();
    const broadcastId = createBroadcastId();
    const frameDir = await makeFrameFixture(root, broadcastId, "chzzk", ["100.jpg"]);
    const reader = new BroadcastFrameReader(new BroadcastPaths(root));

    expect(await reader.listFrameSeconds(broadcastId, "chzzk", 0, Number.MAX_SAFE_INTEGER)).toEqual([100]);
    await rm(frameDir, { recursive: true, force: true });
    expect(await reader.listFrameSeconds(broadcastId, "chzzk", 0, Number.MAX_SAFE_INTEGER)).toEqual([]);
    await rm(root, { recursive: true, force: true });
  });
});

async function makeTempRoot() {
  return mkdtemp(path.join(tmpdir(), "frame-reader-"));
}

/** `<root>/<broadcastId>/frame/<provider>/` 아래에 더미 프레임 파일들을 만든다. */
async function makeFrameFixture(root: string, broadcastId: string, provider: "chzzk" | "soop", fileNames: string[]) {
  const frameDir = path.join(root, broadcastId, "frame", provider);
  await mkdir(frameDir, { recursive: true });
  for (const name of fileNames) {
    await writeFile(path.join(frameDir, name), `frame:${name}`);
  }
  return frameDir;
}
