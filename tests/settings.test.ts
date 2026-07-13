import { describe, expect, it } from "vitest";
import { defaultSettings, normalizeSettings } from "../src/shared/settings";

describe("overlay settings", () => {
  it("clamps numeric settings to broadcast-safe ranges", () => {
    const settings = normalizeSettings({
      maxMessages: 999,
      fontSize: 2,
      backgroundOpacity: 4,
      messageLifetimeSec: -20
    });

    expect(settings.maxMessages).toBe(300);
    expect(settings.fontSize).toBe(14);
    expect(settings.backgroundOpacity).toBe(0.9);
    expect(settings.messageLifetimeSec).toBe(0);
  });

  it("defaults capture quality to 720p", () => {
    expect(defaultSettings.captureQuality).toBe(720);
    expect(normalizeSettings({}).captureQuality).toBe(720);
  });

  it("keeps a supported capture quality", () => {
    expect(normalizeSettings({ captureQuality: 1080 }).captureQuality).toBe(1080);
    expect(normalizeSettings({ captureQuality: 360 }).captureQuality).toBe(360);
  });

  it("falls back to 720p when capture quality is not in the allowlist", () => {
    // 허용목록 밖의 값(외부/조작된 입력)은 신뢰하지 않고 기본값으로 되돌린다.
    expect(normalizeSettings({ captureQuality: 999 as never }).captureQuality).toBe(720);
    expect(normalizeSettings({ captureQuality: undefined }).captureQuality).toBe(720);
  });
});
