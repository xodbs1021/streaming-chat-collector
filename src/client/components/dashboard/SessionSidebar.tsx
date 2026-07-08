import { Clock } from "lucide-react";
import type { RecordingSession } from "../../../shared/types";
import { formatSessionName } from "./format";
import { SessionFilters, SessionMetaEditor } from "./SessionFilters";

export function SessionSidebar({
  liveTotalMessages,
  selectedSessionId,
  onSelectSession,
  providerFilter,
  dateFilter,
  onProviderChange,
  onDateChange,
  selectedSession,
  displayNameDraft,
  onDisplayNameChange,
  onSaveDisplayName,
  visibleSessions
}: {
  liveTotalMessages: number;
  selectedSessionId: string;
  onSelectSession(sessionId: string): void;
  providerFilter: "all" | "chzzk" | "soop";
  dateFilter: string;
  onProviderChange(provider: "all" | "chzzk" | "soop"): void;
  onDateChange(date: string): void;
  selectedSession?: RecordingSession;
  displayNameDraft: string;
  onDisplayNameChange(value: string): void;
  onSaveDisplayName(): void;
  visibleSessions: RecordingSession[];
}) {
  return (
    <aside className="panel session-panel">
      <div className="panel-title">
        <Clock size={20} />
        <h2>세션</h2>
      </div>
      <button className={`session-row ${selectedSessionId === "live" ? "active" : ""}`} onClick={() => onSelectSession("live")}>
        <span>실시간</span>
        <strong>{liveTotalMessages}</strong>
      </button>
      <SessionFilters date={dateFilter} provider={providerFilter} onDateChange={onDateChange} onProviderChange={onProviderChange} />
      {selectedSessionId !== "live" && selectedSession && (
        <SessionMetaEditor displayName={displayNameDraft} onDisplayNameChange={onDisplayNameChange} onSave={onSaveDisplayName} />
      )}
      {visibleSessions.map((session) => (
        <button
          className={`session-row ${selectedSessionId === session.sessionId ? "active" : ""}`}
          key={session.sessionId}
          onClick={() => onSelectSession(session.sessionId)}
        >
          <span>{formatSessionName(session)}</span>
          <strong>{session.messageCount}</strong>
        </button>
      ))}
      {visibleSessions.length === 0 && <div className="empty-state compact-empty">조건에 맞는 세션이 없습니다.</div>}
    </aside>
  );
}
