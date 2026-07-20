import { Circle, Square } from "lucide-react";
import type { RecordingState } from "../../../shared/types";
import { formatRecordingLabel } from "./format";

/**
 * 녹화 시작/종료 버튼 — recordingState 3상태를 formatRecordingLabel로 환산해 그리기만 한다(dumb presentational).
 * 낙관적 갱신 없음: 클릭은 emit만 하고 상태는 서버 recording:status 방출이 되돌린다. status-strip에 상시 노출.
 */
export function RecordingControls({
  recordingState,
  connectedCount,
  onStart,
  onStop
}: {
  recordingState: RecordingState;
  connectedCount: number;
  onStart(): void;
  onStop(): void;
}) {
  const { label, disabled, tooltip, showGracePill } = formatRecordingLabel(recordingState, connectedCount);
  // 네이티브 disabled는 포커스를 막아 툴팁(비활성 사유)이 키보드로 도달 못 한다 → aria-disabled로 포커스는 열어두고 클릭만 가드.
  function handleClick() {
    if (disabled) {
      return;
    }
    if (recordingState === "idle") {
      onStart();
    } else {
      onStop();
    }
  }
  return (
    <div className="recording-controls">
      <button
        aria-disabled={disabled}
        className="ghost-button compact-button"
        onClick={handleClick}
        title={tooltip}
        type="button"
      >
        {recordingState === "idle" ? <Circle size={15} /> : <Square size={15} />}
        {label}
      </button>
      {showGracePill && <span className="recording-grace-pill">유예 중</span>}
    </div>
  );
}
