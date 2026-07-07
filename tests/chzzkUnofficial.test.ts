import { describe, expect, it } from "vitest";
import { parseChzzkChannelInput } from "../src/server/providers/chzzkUnofficial";

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
