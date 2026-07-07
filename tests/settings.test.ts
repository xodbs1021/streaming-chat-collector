import { describe, expect, it } from "vitest";
import { normalizeSettings } from "../src/shared/settings";

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
});
