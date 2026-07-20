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
  const handleClick = recordingState === "idle" ? onStart : onStop;
  return (
    <div className="recording-controls">
      <button className="ghost-button compact-button" disabled={disabled} onClick={handleClick} title={tooltip} type="button">
        {recordingState === "idle" ? <Circle size={15} /> : <Square size={15} />}
        {label}
      </button>
      {showGracePill && <span className="recording-grace-pill">유예 중</span>}
    </div>
  );
}
