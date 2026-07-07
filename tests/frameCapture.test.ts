import { describe, expect, it } from "vitest";
import { extractHlsUrl, findHlsUrlDeep, nearestFrameSecond } from "../src/server/frameCapture";

describe("frame capture helpers", () => {
  it("extracts the HLS media path from livePlaybackJson", () => {
    const playback = JSON.stringify({
      media: [
        { mediaId: "LLHLS", protocol: "HLS", path: "https://example.com/llhls" },
        { mediaId: "HLS", protocol: "HLS", path: "https://example.com/hls" }
      ]
    });
    // protocol=HLS 첫 매치를 사용 — LLHLS도 protocol이 HLS라 첫 항목이 잡힘
    expect(extractHlsUrl(playback)).toBe("https://example.com/llhls");
  });

  it("returns undefined for missing media or invalid json", () => {
    expect(extractHlsUrl(JSON.stringify({ media: [] }))).toBeUndefined();
    expect(extractHlsUrl(JSON.stringify({ media: [{ mediaId: "DASH", path: "x" }] }))).toBeUndefined();
    expect(extractHlsUrl("not-json")).toBeUndefined();
  });

  it("finds an m3u8 URL nested anywhere in a JSON tree", () => {
    const response = { CHANNEL: { RESULT: 1, VIEWPRESET: [{ label: "HD", view_url: "https://cdn.example.com/live/index.m3u8?token=abc" }] } };
    expect(findHlsUrlDeep(response)).toBe("https://cdn.example.com/live/index.m3u8?token=abc");
  });

  it("returns undefined when no m3u8 URL is present", () => {
    expect(findHlsUrlDeep({ CHANNEL: { RESULT: 0 } })).toBeUndefined();
    expect(findHlsUrlDeep({ url: "https://example.com/not-hls.mp4" })).toBeUndefined();
    expect(findHlsUrlDeep(null)).toBeUndefined();
    expect(findHlsUrlDeep("just a string")).toBeUndefined();
  });

  it("finds the nearest frame at or before the target within tolerance", () => {
    const seconds = [100, 105, 110, 120];
    expect(nearestFrameSecond(seconds, 110)).toBe(110);
    expect(nearestFrameSecond(seconds, 112)).toBe(110);
    expect(nearestFrameSecond(seconds, 124)).toBe(120);
    expect(nearestFrameSecond(seconds, 99)).toBeUndefined();
    expect(nearestFrameSecond(seconds, 140)).toBeUndefined();
    expect(nearestFrameSecond([], 100)).toBeUndefined();
  });
});
