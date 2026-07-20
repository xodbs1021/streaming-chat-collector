import type { RecordingSession } from "../../../shared/types";
import { PROVIDER_LABEL } from "./constants";

/**
 * 한 과거 방송의 provider 형제 세션 사이를 전환하는 탭 — 새 상태 축 없이 selectedSessionId만 바꾼다.
 * 과거 방송 열람 중 + 그룹 provider ≥2일 때만 Dashboard가 렌더한다.
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
  return (
    <div className="broadcast-tabs" role="tablist" aria-label="방송 플랫폼 탭">
      {sessions.map((session) => (
        <button
          aria-selected={selectedSessionId === session.sessionId}
          className={selectedSessionId === session.sessionId ? "active" : ""}
          key={session.sessionId}
          onClick={() => onSelectSession(session.sessionId)}
          role="tab"
          type="button"
        >
          {PROVIDER_LABEL[session.provider]} · {session.messageCount.toLocaleString()}
        </button>
      ))}
    </div>
  );
}
