import { describe, expect, it } from "vitest";
import { formatRecordingLabel } from "../src/client/components/dashboard/format";

describe("formatRecordingLabel", () => {
  it("shows the stop label while recording", () => {
    expect(formatRecordingLabel("recording", 2)).toEqual({
      label: "녹화 종료",
      disabled: false,
      showGracePill: false
    });
  });

  it("shows the stop label with a grace pill during the grace period", () => {
    expect(formatRecordingLabel("grace", 2)).toEqual({
      label: "녹화 종료",
      disabled: false,
      showGracePill: true
    });
  });

  it("disables the start button with a tooltip when idle and nothing is connected", () => {
    expect(formatRecordingLabel("idle", 0)).toEqual({
      label: "녹화 시작",
      disabled: true,
      tooltip: "연결된 소스가 없어 녹화를 시작할 수 없습니다.",
      showGracePill: false
    });
  });

  it("enables the start button when idle with at least one connected source", () => {
    expect(formatRecordingLabel("idle", 1)).toEqual({
      label: "녹화 시작",
      disabled: false,
      showGracePill: false
    });
  });
});
