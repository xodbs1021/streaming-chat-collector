import { useRef, type KeyboardEvent } from "react";
import type { RecordingSession } from "../../../shared/types";
import { mergedViewId } from "../../viewSelection";
import { PROVIDER_LABEL } from "./constants";

interface TabItem {
  id: string;
  label: string;
}

/**
 * 한 과거 방송의 뷰 사이를 전환하는 탭 — [합쳐 보기 | 치지직 | SOOP]. 새 상태 축 없이 selectedSessionId만 바꾼다.
 * broadcastId가 오면(=형제 provider ≥2) 맨 앞에 "합쳐 보기"(병합 뷰) 탭을 둔다.
 * ARIA tabs 관례: roving tabindex(선택 탭만 tabIndex=0)로 탭 그룹이 탭 순서에서 한 칸만 차지하고,
 * ←/→로 탭 사이를 순환 선택한다. 과거 방송 열람 중 + 그룹 provider ≥2일 때만 Dashboard가 렌더한다.
 */
export function BroadcastTabs({
  sessions,
  selectedSessionId,
  broadcastId,
  onSelectSession
}: {
  sessions: RecordingSession[];
  selectedSessionId: string;
  /** 형제 provider ≥2 그룹의 방송 id — 있으면 "합쳐 보기" 탭을 맨 앞에 붙인다. */
  broadcastId?: string;
  onSelectSession(sessionId: string): void;
}) {
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);

  const tabs: TabItem[] = [
    ...(broadcastId ? [{ id: mergedViewId(broadcastId), label: "합쳐 보기" }] : []),
    ...sessions.map((session) => ({
      id: session.sessionId,
      label: `${PROVIDER_LABEL[session.provider]} · ${session.messageCount.toLocaleString()}`
    }))
  ];

  function moveTo(index: number) {
    const wrapped = (index + tabs.length) % tabs.length;
    onSelectSession(tabs[wrapped].id);
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
      {tabs.map((tab, index) => {
        const isSelected = selectedSessionId === tab.id;
        return (
          <button
            aria-selected={isSelected}
            className={isSelected ? "active" : ""}
            key={tab.id}
            onClick={() => onSelectSession(tab.id)}
            onKeyDown={(event) => handleKeyDown(event, index)}
            ref={(element) => {
              tabRefs.current[index] = element;
            }}
            role="tab"
            tabIndex={isSelected ? 0 : -1}
            type="button"
          >
            {tab.label}
          </button>
        );
      })}
    </div>
  );
}
