import { describe, expect, it } from "vitest";
import { classifyFfmpegProbe } from "../src/server/ffmpegRuntime";

describe("classifyFfmpegProbe", () => {
  it("treats a spawn error (ENOENT — ffmpeg not installed) as missing", () => {
    expect(classifyFfmpegProbe({ kind: "spawn-error", code: "ENOENT" })).toBe("missing");
  });

  it("treats a clean exit 0 as ready", () => {
    expect(classifyFfmpegProbe({ kind: "exit", code: 0 })).toBe("ready");
  });

  it("treats a non-zero exit as missing", () => {
    expect(classifyFfmpegProbe({ kind: "exit", code: 1 })).toBe("missing");
  });

  it("treats a null exit code (killed by signal) as missing", () => {
    expect(classifyFfmpegProbe({ kind: "exit", code: null })).toBe("missing");
  });
});
