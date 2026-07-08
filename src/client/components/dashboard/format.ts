import type { AnalyticsWindow, HighlightCandidate, RecordingSession, RecordingStatus } from "../../../shared/types";
import { MARKER_COLORS } from "./constants";

export function markerColor(label: string) {
  return MARKER_COLORS[label] ?? "rgba(170, 185, 178, 0.22)";
}

/** 밀리초 구간(startMs~endMs)에 포함되는 초 단위 프레임 시각 목록 */
export function frameSecondsForRange(startMs: number, endMs: number): number[] {
  const startSec = Math.floor(startMs / 1000);
  const endSec = Math.floor((endMs - 1) / 1000);
  const seconds: number[] = [];
  for (let second = startSec; second <= endSec; second += 1) {
    seconds.push(second);
  }
  return seconds;
}

/** 윈도우 구간에 포함되는 초 단위 프레임 시각 목록 — 예: 5초 윈도우 → 5개 */
export function frameSecondsForWindow(window: AnalyticsWindow): number[] {
  return frameSecondsForRange(window.windowStart, window.windowEnd);
}

export function formatPercent(rate: number) {
  return `${Math.round(rate * 1000) / 10}%`;
}

export function formatDuration(durationSec: number) {
  return `${durationSec}초`;
}

export function formatCandidateRange(candidate: HighlightCandidate) {
  return `${formatTime(candidate.startAt)} ~ ${formatTime(candidate.endAt)}`;
}

export function formatViewerBreakdown(counts: Partial<Record<"chzzk" | "soop", number>>) {
  const parts: string[] = [];
  if (counts.chzzk !== undefined) {
    parts.push(`CHZZK ${counts.chzzk.toLocaleString()}`);
  }
  if (counts.soop !== undefined) {
    parts.push(`SOOP ${counts.soop.toLocaleString()}`);
  }
  // 단일 플랫폼이면 합계와 동일하므로 분리 표시 생략
  return parts.length >= 2 ? parts.join(" · ") : undefined;
}

export function formatRecordingMessage(status: RecordingStatus, activeSessions: RecordingSession[]) {
  if (activeSessions.length === 0) {
    return status.message;
  }
  return `${activeSessions.map((session) => session.provider.toUpperCase()).join(" · ")} 저장 중`;
}

export function formatActiveSessions(activeSessions: RecordingSession[]) {
  if (activeSessions.length === 0) {
    return "LIVE";
  }
  return activeSessions.map((session) => `${session.provider.toUpperCase()} · ${session.channelId}`).join(" / ");
}

export function formatSessionName(session: RecordingSession) {
  if (session.displayName) {
    return `${session.displayName} · ${session.provider.toUpperCase()}`;
  }
  return `${formatDate(session.startedAt)} · ${session.provider.toUpperCase()} · ${session.channelId}`;
}

export function filterSessions(sessions: RecordingSession[], provider: "all" | "chzzk" | "soop", date: string) {
  return sessions.filter((session) => {
    if (provider !== "all" && session.provider !== provider) {
      return false;
    }
    if (date && formatDateInput(session.startedAt) !== date) {
      return false;
    }
    return true;
  });
}

function formatDateInput(timestamp: number) {
  const date = new Date(timestamp);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function formatDate(timestamp: number) {
  return new Intl.DateTimeFormat("ko-KR", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  }).format(timestamp);
}

export function formatTime(timestamp: number) {
  return new Intl.DateTimeFormat("ko-KR", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  }).format(timestamp);
}

export function formatWindowRange(window: AnalyticsWindow) {
  return `${formatTime(window.windowStart)} ~ ${formatTime(window.windowEnd)}`;
}
