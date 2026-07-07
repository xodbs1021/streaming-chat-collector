import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchChzzkViewerCount, parseChzzkChannelInput } from "../src/server/providers/chzzkUnofficial";

describe("chzzk unofficial adapter input parsing", () => {
  it("accepts plain channel ids", () => {
    expect(parseChzzkChannelInput("N2aiJi")).toEqual({ channelId: "N2aiJi" });
    expect(parseChzzkChannelInput("@N2aiJi")).toEqual({ channelId: "N2aiJi" });
  });

  it("accepts live and channel URLs", () => {
    expect(parseChzzkChannelInput("https://chzzk.naver.com/live/N2aiJi")).toEqual({ channelId: "N2aiJi" });
    expect(parseChzzkChannelInput("chzzk.naver.com/live/N2aiJi?from=share")).toEqual({ channelId: "N2aiJi" });
    expect(parseChzzkChannelInput("https://chzzk.naver.com/channel/N2aiJi")).toEqual({ channelId: "N2aiJi" });
  });

  it("accepts query-based channel URLs", () => {
    expect(parseChzzkChannelInput("https://chzzk.naver.com/live?channelId=N2aiJi")).toEqual({ channelId: "N2aiJi" });
  });

  it("rejects unsupported hosts and empty input", () => {
    expect(parseChzzkChannelInput("")).toBeUndefined();
    expect(parseChzzkChannelInput("https://example.com/live/N2aiJi")).toBeUndefined();
    expect(parseChzzkChannelInput("https://notchzzk.naver.com/live/N2aiJi")).toBeUndefined();
  });
});

describe("fetchChzzkViewerCount", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("reports live=true and the viewer count while the broadcast is open", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, json: async () => ({ content: { status: "OPEN", concurrentUserCount: 42 } }) })
    );
    await expect(fetchChzzkViewerCount("N2aiJi")).resolves.toEqual({ count: 42, live: true });
  });

  it("reports live=false when the broadcast status is CLOSE", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ content: { status: "CLOSE" } }) }));
    await expect(fetchChzzkViewerCount("N2aiJi")).resolves.toEqual({ count: undefined, live: false });
  });

  it("assumes still live when the status field is missing (stale/partial response)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ content: {} }) }));
    await expect(fetchChzzkViewerCount("N2aiJi")).resolves.toEqual({ count: undefined, live: true });
  });

  it("returns undefined when the request fails", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false }));
    await expect(fetchChzzkViewerCount("N2aiJi")).resolves.toBeUndefined();
  });
});
