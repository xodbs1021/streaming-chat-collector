import { describe, expect, it } from "vitest";
import {
  classifyReadiness,
  planFromReadiness,
  CAPTURE_READY_TIMEOUT_MS,
  type CaptureReadiness
} from "../src/shared/captureReadiness";
import type { FrameCaptureSnapshot } from "../src/shared/frameCaptureStatus";

/** enabled=true·나머지 비활성인 기본 스냅샷에 케이스별 필드만 덮어쓴다 */
function snapshot(overrides: Partial<FrameCaptureSnapshot> = {}): FrameCaptureSnapshot {
  return {
    enabled: true,
    stopped: false,
    capturing: false,
    restartScheduled: false,
    restartAttempts: 0,
    frameCount: 0,
    ffmpegMissing: false,
    ...overrides
  };
}

const TIMEOUT = CAPTURE_READY_TIMEOUT_MS;

describe("classifyReadiness", () => {
  it("returns ffmpeg-missing when ffmpeg is missing, ahead of every other signal", () => {
    expect(classifyReadiness(snapshot({ ffmpegMissing: true, capturing: true }), 0, TIMEOUT)).toBe("ffmpeg-missing");
  });

  it("returns cancelled when stopped, ahead of a lingering capturing child [B1]", () => {
    expect(classifyReadiness(snapshot({ stopped: true, capturing: true }), 0, TIMEOUT)).toBe("cancelled");
  });

  it("returns ready when a child is capturing", () => {
    expect(classifyReadiness(snapshot({ capturing: true }), 0, TIMEOUT)).toBe("ready");
  });

  it("returns no-hls for the no-hls failure reason", () => {
    expect(classifyReadiness(snapshot({ lastFailureReason: "no-hls" }), 0, TIMEOUT)).toBe("no-hls");
  });

  it("returns stream-error early for spawn-error (no waiting for timeout)", () => {
    expect(classifyReadiness(snapshot({ lastFailureReason: "spawn-error" }), 0, TIMEOUT)).toBe("stream-error");
  });

  it("returns stream-error early for ffmpeg-exit (no waiting for timeout)", () => {
    expect(classifyReadiness(snapshot({ lastFailureReason: "ffmpeg-exit" }), 0, TIMEOUT)).toBe("stream-error");
  });

  it("stays pending before the timeout with no verdict yet", () => {
    expect(classifyReadiness(snapshot(), TIMEOUT - 1, TIMEOUT)).toBe("pending");
  });

  it("returns timeout at the boundary (elapsed === timeout)", () => {
    expect(classifyReadiness(snapshot(), TIMEOUT, TIMEOUT)).toBe("timeout");
  });

  it("returns timeout once elapsed exceeds the timeout", () => {
    expect(classifyReadiness(snapshot(), TIMEOUT + 500, TIMEOUT)).toBe("timeout");
  });

  it("prioritizes the early stream-error verdict over an elapsed timeout", () => {
    expect(classifyReadiness(snapshot({ lastFailureReason: "spawn-error" }), TIMEOUT + 1, TIMEOUT)).toBe("stream-error");
  });
});

describe("planFromReadiness", () => {
  it("starts chat with no warning for ready", () => {
    expect(planFromReadiness("ready")).toEqual({ startChat: true });
  });

  it("starts chat with no warning for disabled", () => {
    expect(planFromReadiness("disabled")).toEqual({ startChat: true });
  });

  it("skips chat only for cancelled", () => {
    expect(planFromReadiness("cancelled")).toEqual({ startChat: false });
  });

  it("starts chat with a non-empty warning for every degraded readiness", () => {
    const degraded: CaptureReadiness[] = ["no-hls", "stream-error", "ffmpeg-missing", "timeout"];
    for (const readiness of degraded) {
      const plan = planFromReadiness(readiness);
      expect(plan.startChat).toBe(true);
      expect(plan.warning && plan.warning.length).toBeGreaterThan(0);
    }
  });

  it("gives each degraded readiness a distinct warning", () => {
    const warnings = (["no-hls", "stream-error", "ffmpeg-missing", "timeout"] as CaptureReadiness[]).map(
      (readiness) => planFromReadiness(readiness).warning
    );
    expect(new Set(warnings).size).toBe(warnings.length);
  });
});
