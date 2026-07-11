import { describe, expect, it } from "vitest";
import { computeCaptureStatus, type FrameCaptureSnapshot } from "../src/shared/frameCaptureStatus";

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

describe("computeCaptureStatus", () => {
  it("reports capturing when a child is capturing", () => {
    expect(computeCaptureStatus(snapshot({ capturing: true })).state).toBe("capturing");
  });

  it("reports unavailable when ffmpeg is missing", () => {
    expect(computeCaptureStatus(snapshot({ ffmpegMissing: true })).state).toBe("unavailable");
  });

  it("reports unsupported for the no-hls failure reason", () => {
    expect(computeCaptureStatus(snapshot({ lastFailureReason: "no-hls", restartScheduled: true })).state).toBe("unsupported");
  });

  it("reports retrying for a spawn-error failure reason", () => {
    expect(computeCaptureStatus(snapshot({ lastFailureReason: "spawn-error" })).state).toBe("retrying");
  });

  it("reports retrying for an ffmpeg-exit failure reason", () => {
    expect(computeCaptureStatus(snapshot({ lastFailureReason: "ffmpeg-exit" })).state).toBe("retrying");
  });

  it("reports idle when a restart is pending but no failure reason is set", () => {
    expect(computeCaptureStatus(snapshot({ restartAttempts: 2 })).state).toBe("idle");
  });

  it("reports idle when capture is disabled", () => {
    expect(computeCaptureStatus(snapshot({ enabled: false })).state).toBe("idle");
  });

  it("reports idle when stopped with no failure reason", () => {
    expect(computeCaptureStatus(snapshot({ stopped: true })).state).toBe("idle");
  });

  it("reports idle when stopped even with a stale failure reason (post-disconnect residue)", () => {
    expect(computeCaptureStatus(snapshot({ stopped: true, lastFailureReason: "no-hls", restartAttempts: 3 })).state).toBe("idle");
  });

  it("prioritizes unavailable over stopped (actual state after an ENOENT spawn error)", () => {
    expect(computeCaptureStatus(snapshot({ ffmpegMissing: true, stopped: true })).state).toBe("unavailable");
  });

  it("prioritizes stopped over a lingering capturing flag (mid-teardown)", () => {
    expect(computeCaptureStatus(snapshot({ stopped: true, capturing: true })).state).toBe("idle");
  });

  it("attaches a non-empty message to every case", () => {
    const cases: Array<Partial<FrameCaptureSnapshot>> = [
      { capturing: true },
      { ffmpegMissing: true },
      { lastFailureReason: "no-hls", restartScheduled: true },
      { lastFailureReason: "spawn-error" },
      { lastFailureReason: "ffmpeg-exit" },
      { restartAttempts: 2 },
      { enabled: false },
      { stopped: true },
      { stopped: true, lastFailureReason: "no-hls", restartAttempts: 3 }
    ];
    for (const override of cases) {
      expect(computeCaptureStatus(snapshot(override)).message.length).toBeGreaterThan(0);
    }
  });
});
