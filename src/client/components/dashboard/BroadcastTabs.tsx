import { useRef, type KeyboardEvent } from "react";
import type { RecordingSession } from "../../../shared/types";
import { PROVIDER_LABEL } from "./constants";

/**
 * 한 과거 방송의 provider 형제 세션 사이를 전환하는 탭 — 새 상태 축 없이 selectedSessionId만 바꾼다.
 * ARIA tabs 관례: roving tabindex(선택 탭만 tabIndex=0)로 탭 그룹이 탭 순서에서 한 칸만 차지하고,
 * ←/→로 형제 사이를 순환 선택한다. 과거 방송 열람 중 + 그룹 provider ≥2일 때만 Dashboard가 렌더한다.
 */
export function BroadcastTabs({
  sessions,
  selectedSessionId,
  onSelectSession
}: {
  sessions: RecordingSession[];
  selectedSessionId: string;
  onSelectSession(sessionId: string): void;
}) {
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);

  function moveTo(index: number) {
    const wrapped = (index + sessions.length) % sessions.length;
    onSelectSession(sessions[wrapped].sessionId);
    tabRefs.current[wrapped]?.focus();
  }

  function handleKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    if (event.key === "ArrowRight") {
      event.preventDefault();
      moveTo(index + 1);
    } else if (event.key === "ArrowLeft") {
      event.preventDefault();
      moveTo(index - 1);
    }
  }

  return (
    <div className="broadcast-tabs" role="tablist" aria-label="방송 플랫폼 탭">
      {sessions.map((session, index) => {
        const isSelected = selectedSessionId === session.sessionId;
        return (
          <button
            aria-selected={isSelected}
            className={isSelected ? "active" : ""}
            key={session.sessionId}
            onClick={() => onSelectSession(session.sessionId)}
            onKeyDown={(event) => handleKeyDown(event, index)}
            ref={(element) => {
              tabRefs.current[index] = element;
            }}
            role="tab"
            tabIndex={isSelected ? 0 : -1}
            type="button"
          >
            {PROVIDER_LABEL[session.provider]} · {session.messageCount.toLocaleString()}
          </button>
        );
      })}
    </div>
  );
}
