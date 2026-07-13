import { describe, expect, it } from "vitest";
import { buildFfmpegArgs, extractHlsUrl, findHlsUrlDeep, nearestFrameSecond } from "../src/server/frameCapture";

describe("buildFfmpegArgs", () => {
  const params = { hlsUrl: "https://cdn.example.com/live/index.m3u8?token=abc", fps: 1, height: 720, jpegQuality: 5 };

  it("includes -re for input pacing before the -i input flag", () => {
    const args = buildFfmpegArgs(params);
    const reIndex = args.indexOf("-re");
    const inputIndex = args.indexOf("-i");
    expect(reIndex).toBeGreaterThanOrEqual(0);
    expect(reIndex).toBeLessThan(inputIndex);
  });

  it("keeps the fps/scale and quality settings", () => {
    const args = buildFfmpegArgs(params);
    expect(args[args.indexOf("-vf") + 1]).toBe("fps=1,scale=-2:720");
    expect(args[args.indexOf("-q:v") + 1]).toBe("5");
  });

  it("reflects the selected capture height in the scale filter", () => {
    // 화질 셀렉터 값이 scale=-2:<height>로 그대로 흘러야 한다.
    const hi = buildFfmpegArgs({ ...params, height: 1080 });
    const lo = buildFfmpegArgs({ ...params, height: 360 });
    expect(hi[hi.indexOf("-vf") + 1]).toBe("fps=1,scale=-2:1080");
    expect(lo[lo.indexOf("-vf") + 1]).toBe("fps=1,scale=-2:360");
  });

  it("streams mjpeg frames to stdout instead of writing strftime-named files", () => {
    const args = buildFfmpegArgs(params);
    // 명명 주체를 ffmpeg에서 Node로 옮겼다 — strftime/%s.jpg는 제거되고 파이프로 전환.
    expect(args).not.toContain("-strftime");
    expect(args.some((arg) => arg.includes("%s.jpg"))).toBe(false);
    expect(args[args.indexOf("-f") + 1]).toBe("image2pipe");
    expect(args[args.indexOf("-c:v") + 1]).toBe("mjpeg");
    expect(args[args.length - 1]).toBe("pipe:1");
  });

  it("passes the HLS URL through untouched", () => {
    const args = buildFfmpegArgs(params);
    expect(args[args.indexOf("-i") + 1]).toBe(params.hlsUrl);
  });
});

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
