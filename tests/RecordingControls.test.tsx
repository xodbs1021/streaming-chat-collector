import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { RecordingControls } from "../src/client/components/dashboard/RecordingControls";
import type { RecordingState } from "../src/shared/types";

function setup(overrides: { recordingState?: RecordingState; connectedCount?: number } = {}) {
  const onStart = vi.fn();
  const onStop = vi.fn();
  render(
    <RecordingControls
      connectedCount={overrides.connectedCount ?? 1}
      recordingState={overrides.recordingState ?? "idle"}
      onStart={onStart}
      onStop={onStop}
    />
  );
  return { onStart, onStop, button: screen.getByRole("button") };
}

describe("RecordingControls", () => {
  it("emits start (not stop) when idle and clicked", () => {
    const { onStart, onStop, button } = setup({ recordingState: "idle", connectedCount: 1 });

    fireEvent.click(button);

    expect(onStart).toHaveBeenCalledTimes(1);
    expect(onStop).not.toHaveBeenCalled();
  });

  it("emits stop (not start) when recording and clicked", () => {
    const { onStart, onStop, button } = setup({ recordingState: "recording", connectedCount: 1 });

    fireEvent.click(button);

    expect(onStop).toHaveBeenCalledTimes(1);
    expect(onStart).not.toHaveBeenCalled();
  });

  it("emits stop (not start) when in the grace period and clicked", () => {
    const { onStart, onStop, button } = setup({ recordingState: "grace", connectedCount: 1 });

    fireEvent.click(button);

    expect(onStop).toHaveBeenCalledTimes(1);
    expect(onStart).not.toHaveBeenCalled();
  });

  it("stays focusable but emits nothing when idle with no connected source", () => {
    const { onStart, onStop, button } = setup({ recordingState: "idle", connectedCount: 0 });

    // 네이티브 disabled면 포커스 불가라 툴팁이 키보드로 안 잡힌다 → aria-disabled로 포커스는 유지하고 클릭만 가드
    expect(button).toHaveAttribute("aria-disabled", "true");
    expect(button).not.toBeDisabled();

    fireEvent.click(button);

    expect(onStart).not.toHaveBeenCalled();
    expect(onStop).not.toHaveBeenCalled();
  });
});
