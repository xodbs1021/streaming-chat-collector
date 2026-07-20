import { Clock } from "lucide-react";
import type { RecordingSession } from "../../../shared/types";
import type { BroadcastGroup } from "./broadcastGroups";
import { defaultSessionOf } from "./broadcastGroups";
import { PROVIDER_LABEL } from "./constants";
import { formatBroadcastName } from "./format";
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
  visibleGroups
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
  visibleGroups: BroadcastGroup[];
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
      {visibleGroups.map((group) => {
        // 방송 1행 — 클릭 시 기본 provider 세션을 선택하고, 탭이 형제 provider로 전환한다.
        const primary = defaultSessionOf(group);
        const isActive = group.sessions.some((session) => session.sessionId === selectedSessionId);
        // 배지가 있는 다중 provider 행만 3열 그리드로 — 단일/실시간 행은 2열 유지(카운트가 뜨지 않게).
        const hasBadges = group.sessions.length >= 2;
        return (
          <button
            className={`session-row ${isActive ? "active" : ""} ${hasBadges ? "has-badges" : ""}`}
            key={group.groupKey}
            onClick={() => onSelectSession(primary.sessionId)}
          >
            <span>{formatBroadcastName(group)}</span>
            {group.sessions.length >= 2 && (
              <span className="session-provider-badges">
                {group.sessions.map((session) => (
                  <em key={session.provider}>{PROVIDER_LABEL[session.provider]}</em>
                ))}
              </span>
            )}
            <strong>{group.totalMessageCount}</strong>
          </button>
        );
      })}
      {visibleGroups.length === 0 && <div className="empty-state compact-empty">조건에 맞는 세션이 없습니다.</div>}
    </aside>
  );
}
