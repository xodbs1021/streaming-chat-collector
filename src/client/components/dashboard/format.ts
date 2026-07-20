import type { AnalyticsWindow, HighlightCandidate, RecordingSession, RecordingState, RecordingStatus } from "../../../shared/types";
import type { BroadcastGroup } from "./broadcastGroups";
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

/** 사이드바 방송 행 이름 — 단일 세션은 현행 외관 보존, 다중 provider는 provider를 배지가 전달하므로 이름에서 생략(중복·표기 엇갈림 방지). */
export function formatBroadcastName(group: BroadcastGroup) {
  if (group.sessions.length === 1) {
    return formatSessionName(group.sessions[0]);
  }
  return group.displayName ?? formatDate(group.startedAt);
}

const RECORDING_START_LABEL = "녹화 시작";
const RECORDING_STOP_LABEL = "녹화 종료";
const RECORDING_NO_SOURCE_TOOLTIP = "연결된 소스가 없어 녹화를 시작할 수 없습니다.";

/** 녹화 버튼 3상태(idle/recording/grace)를 렌더 전 필드로 환산 — RecordingControls는 이 구조체를 그리기만 한다. */
export interface RecordingButtonState {
  label: string;
  disabled: boolean;
  tooltip?: string;
  showGracePill: boolean;
}

export function formatRecordingLabel(state: RecordingState, connectedCount: number): RecordingButtonState {
  if (state === "recording") {
    return { label: RECORDING_STOP_LABEL, disabled: false, showGracePill: false };
  }
  if (state === "grace") {
    return { label: RECORDING_STOP_LABEL, disabled: false, showGracePill: true };
  }
  if (connectedCount === 0) {
    return { label: RECORDING_START_LABEL, disabled: true, tooltip: RECORDING_NO_SOURCE_TOOLTIP, showGracePill: false };
  }
  return { label: RECORDING_START_LABEL, disabled: false, showGracePill: false };
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
  // 브라우저 로컬 TZ와 무관하게 항상 KST — 사이드바 방송/세션 이름의 날짜가 형제·프레임 시각과 어긋나지 않게.
  return new Intl.DateTimeFormat("ko-KR", {
    timeZone: "Asia/Seoul",
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

// 프레임 파일명(에폭 초)은 매칭·보존·API의 키라 불변 — 사람이 읽는 시각은 표시 계층에서만 변환한다.
// 브라우저 로컬 TZ와 무관하게 항상 KST. hourCycle:"h23"은 hour12:false 단독 시 h24(24:00) 매핑 사례 회피.
const FRAME_TS_FMT = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Seoul",
  hourCycle: "h23",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit"
});

/** 에폭 초 → "2026.07.11 17:02:03" (KST) */
export function formatFrameTimestamp(epochSec: number): string {
  const parts = FRAME_TS_FMT.formatToParts(epochSec * 1000);
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  return `${get("year")}.${get("month")}.${get("day")} ${get("hour")}:${get("minute")}:${get("second")}`;
}
