import { describe, expect, it, vi } from "vitest";
import { createBroadcastId, isValidBroadcastId } from "../src/server/broadcast/broadcastId";
import { composeSessionKey, parseSessionKey } from "../src/server/broadcast/sessionKey";
import { BroadcastPaths } from "../src/server/broadcast/broadcastPaths";
import { RecordingGrace } from "../src/server/broadcast/recordingGrace";

describe("createBroadcastId", () => {
  it("`날짜-시각-6hex` 형식을 만든다", () => {
    const id = createBroadcastId(new Date(2026, 6, 14, 15, 30, 12)); // month는 0-index → 7월
    expect(id).toMatch(/^20260714-153012-[0-9a-f]{6}$/);
  });

  it("같은 초라도 서로 다른 id를 만든다(6hex 충돌 방지)", () => {
    const now = new Date(2026, 6, 14, 15, 30, 12);
    expect(createBroadcastId(now)).not.toBe(createBroadcastId(now));
  });
});

describe("isValidBroadcastId", () => {
  it("createBroadcastId 출력을 통과시킨다", () => {
    expect(isValidBroadcastId(createBroadcastId())).toBe(true);
  });

  it("형식 이탈을 거부한다", () => {
    expect(isValidBroadcastId("")).toBe(false);
    expect(isValidBroadcastId("20260714-153012")).toBe(false); // hex 없음
    expect(isValidBroadcastId("20260714-153012-A1B2C3")).toBe(false); // 대문자 hex
    expect(isValidBroadcastId("../../etc")).toBe(false);
    expect(isValidBroadcastId("20260714-153012-a1b2c3__chzzk")).toBe(false); // 합성 키
  });
});

describe("sessionKey", () => {
  it("compose/parse 라운드트립", () => {
    const key = composeSessionKey("20260714-153012-a1b2c3", "soop");
    expect(key).toBe("20260714-153012-a1b2c3__soop");
    expect(parseSessionKey(key)).toEqual({ broadcastId: "20260714-153012-a1b2c3", provider: "soop" });
  });

  it("형식이 아니면 undefined", () => {
    expect(parseSessionKey("legacy-flat-id")).toBeUndefined(); // 구분자 없음
    expect(parseSessionKey("bid__mixer")).toBeUndefined(); // 알 수 없는 provider
    expect(parseSessionKey("__chzzk")).toBeUndefined(); // broadcastId 빈 값
  });
});

describe("BroadcastPaths", () => {
  const paths = new BroadcastPaths("/data");

  it("방송/provider 파일 경로를 조립한다", () => {
    expect(paths.broadcastMetaPath("bid")).toBe("/data/bid/broadcast.meta.json");
    expect(paths.chatFilePath("bid", "chzzk")).toBe("/data/bid/chat/chzzk/chat.jsonl");
    expect(paths.metaFilePath("bid", "chzzk")).toBe("/data/bid/chat/chzzk/meta.json");
    expect(paths.viewersFilePath("bid", "soop")).toBe("/data/bid/chat/soop/viewers.jsonl");
  });

  it("프레임 폴더를 방송/provider별로 조립한다 (chat과 형제)", () => {
    expect(paths.frameDir("bid", "chzzk")).toBe("/data/bid/frame/chzzk");
    expect(paths.frameDir("bid", "soop")).toBe("/data/bid/frame/soop");
  });
});

describe("RecordingGrace", () => {
  it("예약 후 만료되면 onExpire를 1회 호출한다", async () => {
    const onExpire = vi.fn();
    const grace = new RecordingGrace(5, onExpire);
    grace.schedule();
    expect(grace.isPending()).toBe(true);
    await delay(25);
    expect(onExpire).toHaveBeenCalledTimes(1);
    expect(grace.isPending()).toBe(false);
  });

  it("만료 전에 취소하면 onExpire를 호출하지 않는다", async () => {
    const onExpire = vi.fn();
    const grace = new RecordingGrace(20, onExpire);
    grace.schedule();
    grace.cancel();
    expect(grace.isPending()).toBe(false);
    await delay(40);
    expect(onExpire).not.toHaveBeenCalled();
  });

  it("중복 schedule은 타이머를 하나만 유지한다", async () => {
    const onExpire = vi.fn();
    const grace = new RecordingGrace(5, onExpire);
    grace.schedule();
    grace.schedule();
    await delay(25);
    expect(onExpire).toHaveBeenCalledTimes(1);
  });
});

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
