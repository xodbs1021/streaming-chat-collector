import { describe, expect, it } from "vitest";
import { resolveFrameChannelInput } from "../src/server/frameChannel";

const CHZZK_ID = "75cbf189b3bb8f9f687d2aca0d0a382b";

describe("resolveFrameChannelInput", () => {
  it("normalizes a pasted chzzk live URL to the channel id (2026-07-12 incident)", () => {
    expect(resolveFrameChannelInput("chzzk", `https://chzzk.naver.com/live/${CHZZK_ID}`)).toBe(CHZZK_ID);
  });

  it("passes a plain chzzk channel id through unchanged", () => {
    expect(resolveFrameChannelInput("chzzk", CHZZK_ID)).toBe(CHZZK_ID);
  });

  it("normalizes a soop live URL to the bj id", () => {
    expect(resolveFrameChannelInput("soop", "https://play.sooplive.co.kr/somebj123")).toBe("somebj123");
  });

  it("passes a plain soop bj id through unchanged", () => {
    expect(resolveFrameChannelInput("soop", "somebj123")).toBe("somebj123");
  });

  it("returns undefined for empty or unparseable input", () => {
    expect(resolveFrameChannelInput("chzzk", "  ")).toBeUndefined();
    expect(resolveFrameChannelInput("chzzk", "https://youtube.com/watch?v=abc")).toBeUndefined();
  });
});
