import { Activity, BarChart3, Clock, Download, Eye, Flame, Hash, MessageSquareText, Moon, Percent, RotateCcw, Save, Sun, Tag, Trash2, Users, X } from "lucide-react";
import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import type { MouseEvent, ReactNode } from "react";
import type {
  AnalyticsRankItem,
  AnalyticsSummary,
  AnalyticsWindow,
  ChatRecord,
  HighlightAnnotation,
  HighlightCandidate,
  HighlightCategory,
  HighlightLevel,
  HighlightSummary,
  HighlightThresholds,
  ProviderStatusMap,
  RecordingSession,
  RecordingStatus,
  TimelineMarker,
  WindowComparisonSummary
} from "../../shared/types";
import { socket } from "../socket";

const WINDOW_OPTIONS = [1, 3, 5, 10];
const BAR_WIDTH = 7;
const BAR_GAP = 3;
const SLOT_WIDTH = BAR_WIDTH + BAR_GAP;
const CHART_HEIGHT = 200;
const CHART_BOTTOM_PAD = 20;
const RENDER_BUFFER_SLOTS = 20;
const MAX_FILLED_SLOTS = 50_000;
const TIME_LABEL_SLOT_INTERVAL = 15;
const MAX_TRACKED_KEYWORDS = 8;
const SESSIONS_REFRESH_THROTTLE_MS = 5_000;
/** 구간 종료 표시 — 직전 구간의 띠를 여기서 끊고, 다음 마커 전까지 빈 구간으로 둔다 */
const MARKER_END_LABEL = "종료";
const MARKER_PRESETS = ["밴픽", "게임", "휴식", "광고", MARKER_END_LABEL];
// 캡처가 1fps라 프레임 자체가 최대 1초 간격 — 300ms면 5장이 1.5초에 한 바퀴 돌아
// "영상처럼 움직이는" 느낌을 주면서도 각 프레임이 눈에 들어오는 균형점
const FRAME_PLAYBACK_INTERVAL_MS = 300;
const MARKER_COLORS: Record<string, string> = {
  밴픽: "rgba(143, 198, 255, 0.24)",
  게임: "rgba(49, 232, 149, 0.2)",
  휴식: "rgba(255, 207, 93, 0.22)",
  광고: "rgba(255, 107, 125, 0.22)"
};

interface LiveMarkersResponse {
  sessionId?: string;
  canSave: boolean;
  markers: TimelineMarker[];
}
const MIN_SPIKE_SAMPLE_WINDOWS = 12;
const SPIKE_ALERT_MAX_AGE_MS = 30_000;
const SPIKE_TOAST_LIFETIME_MS = 6_000;

interface TimelineSelection {
  startAt: number;
  endAt: number;
}

const emptySummary: AnalyticsSummary = {
  generatedAt: 0,
  windowSec: 5,
  totalMessages: 0,
  uniqueChatters: 0,
  providerCounts: {},
  roleCounts: {},
  topChatters: [],
  topTerms: [],
  topEmotes: [],
  recentMessages: [],
  windows: []
};

const initialRecordingStatus: RecordingStatus = {
  enabled: true,
  dataDir: "",
  message: "저장 대기 중"
};

const emptyComparison: WindowComparisonSummary = {
  generatedAt: 0,
  items: []
};

const emptyHighlightSummary: HighlightSummary = {
  generatedAt: 0,
  windowSec: 5,
  canSaveAnnotations: false,
  thresholds: {
    activeWindowMean: 0,
    p95: 0,
    p99: 0,
    max: 0,
    windowCount: 0,
    activeWindowCount: 0,
    candidateWindowCount: 0
  },
  candidates: [],
  annotations: {}
};

const HIGHLIGHT_CATEGORIES: Array<{ value: HighlightCategory; label: string }> = [
  { value: "teamfight", label: "한타" },
  { value: "player_mistake", label: "실수" },
  { value: "objective", label: "오브젝트" },
  { value: "solo_kill", label: "솔로킬" },
  { value: "pentakill", label: "펜타킬" },
  { value: "macro", label: "운영" },
  { value: "other", label: "기타" }
];

export function DashboardRoute() {
  const [sessions, setSessions] = useState<RecordingSession[]>([]);
  const [selectedSessionId, setSelectedSessionId] = useState("live");
  const [liveSummary, setLiveSummary] = useState<AnalyticsSummary>(emptySummary);
  const [sessionSummary, setSessionSummary] = useState<AnalyticsSummary | undefined>();
  const [highlightSummary, setHighlightSummary] = useState<HighlightSummary>(emptyHighlightSummary);
  const [windowComparison, setWindowComparison] = useState<WindowComparisonSummary>(emptyComparison);
  const [saveState, setSaveState] = useState<Record<string, "saving" | "saved" | "error">>({});
  const [selectedRange, setSelectedRange] = useState<TimelineSelection | undefined>();
  const [focusRange, setFocusRange] = useState<TimelineSelection | undefined>();
  const [recordingStatus, setRecordingStatus] = useState<RecordingStatus>(initialRecordingStatus);
  const [sessionProviderFilter, setSessionProviderFilter] = useState<"all" | "chzzk" | "soop">("all");
  const [theme, setTheme] = useState<"dark" | "light">(() =>
    localStorage.getItem("chat-theme") === "light" ? "light" : "dark"
  );
  const [sessionDateFilter, setSessionDateFilter] = useState("");
  const [displayNameDraft, setDisplayNameDraft] = useState("");
  const [windowSec, setWindowSec] = useState(5);
  const [keywords, setKeywords] = useState<string[]>([]);
  const [keywordInput, setKeywordInput] = useState("");
  const [spikeToasts, setSpikeToasts] = useState<Array<{ id: number; message: string }>>([]);
  const [providerViewerCounts, setProviderViewerCounts] = useState<Partial<Record<"chzzk" | "soop", number>>>({});
  const [markers, setMarkers] = useState<TimelineMarker[]>([]);
  const [markersSessionId, setMarkersSessionId] = useState<string | undefined>();
  const [canSaveMarkers, setCanSaveMarkers] = useState(false);
  const [markerLabelInput, setMarkerLabelInput] = useState("");
  const windowSecRef = useRef(windowSec);
  const selectedSessionIdRef = useRef(selectedSessionId);
  const lastSpikeWindowRef = useRef(0);

  useEffect(() => {
    void loadSessions();

    // recording:status는 채팅 유입 중 고빈도로 도착하므로, 세션 목록(REST) 재조회는 스로틀
    let lastSessionsRefreshAt = 0;
    const onRecordingStatus = (status: RecordingStatus) => {
      setRecordingStatus(status);
      const now = Date.now();
      if (now - lastSessionsRefreshAt >= SESSIONS_REFRESH_THROTTLE_MS) {
        lastSessionsRefreshAt = now;
        void loadSessions();
      }
    };
    const onLiveAnalytics = (summary: AnalyticsSummary) => {
      if (summary.windowSec === windowSecRef.current) {
        if (summary.partialWindows) {
          setLiveSummary((current) => mergePartialSummary(current, summary));
        } else {
          setLiveSummary(summary);
        }
        return;
      }
      setLiveSummary((current) => ({
        ...current,
        generatedAt: summary.generatedAt,
        totalMessages: summary.totalMessages,
        uniqueChatters: summary.uniqueChatters,
        startedAt: summary.startedAt,
        endedAt: summary.endedAt,
        session: summary.session,
        providerCounts: summary.providerCounts,
        roleCounts: summary.roleCounts,
        topChatters: summary.topChatters,
        topTerms: summary.topTerms,
        topEmotes: summary.topEmotes,
        recentMessages: summary.recentMessages,
        viewerCount: summary.viewerCount,
        participationRate: summary.participationRate
      }));
    };

    const onProviderStatuses = (statuses: ProviderStatusMap) => {
      setProviderViewerCounts({
        chzzk: statuses.chzzk?.state === "connected" ? statuses.chzzk.viewerCount : undefined,
        soop: statuses.soop?.state === "connected" ? statuses.soop.viewerCount : undefined
      });
    };

    socket.on("recording:status", onRecordingStatus);
    socket.on("analytics:live", onLiveAnalytics);
    socket.on("provider:statuses", onProviderStatuses);

    return () => {
      socket.off("recording:status", onRecordingStatus);
      socket.off("analytics:live", onLiveAnalytics);
      socket.off("provider:statuses", onProviderStatuses);
    };
  }, []);

  useEffect(() => {
    windowSecRef.current = windowSec;
  }, [windowSec]);

  useEffect(() => {
    selectedSessionIdRef.current = selectedSessionId;
  }, [selectedSessionId]);

  useEffect(() => {
    setSelectedRange(undefined);
    setFocusRange(undefined);
    setSaveState({});
  }, [selectedSessionId, windowSec]);

  useEffect(() => {
    const clearOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        clearSelection();
      }
    };
    window.addEventListener("keydown", clearOnEscape);
    return () => {
      window.removeEventListener("keydown", clearOnEscape);
    };
  }, []);

  useEffect(() => {
    if (selectedSessionId !== "live") {
      return undefined;
    }
    let cancelled = false;
    const keywordParam = keywords.length > 0 ? `&keywords=${encodeURIComponent(keywords.join(","))}` : "";

    async function loadLiveSummary() {
      try {
        const next = await fetchJson<AnalyticsSummary>(`/api/analytics/live?windowSec=${windowSec}${keywordParam}`);
        if (!cancelled && selectedSessionIdRef.current === "live") {
          setLiveSummary(next);
        }
      } catch {
        // 일시적 오류 — 다음 폴링 또는 소켓 업데이트에서 복구
      }
    }

    setSessionSummary(undefined);
    void loadLiveSummary();
    // windowSec 5(소켓 기본)에 키워드가 없으면 소켓 푸시만으로 충분 — 폴링 생략
    const needsPolling = windowSec !== 5 || keywords.length > 0;
    const intervalId = needsPolling ? window.setInterval(() => void loadLiveSummary(), 1_000) : undefined;
    return () => {
      cancelled = true;
      if (intervalId !== undefined) {
        window.clearInterval(intervalId);
      }
    };
  }, [selectedSessionId, windowSec, keywords]);

  useEffect(() => {
    if (selectedSessionId !== "live") {
      return undefined;
    }
    let cancelled = false;

    async function loadLiveDetails() {
      try {
        const [nextHighlights, nextComparison, nextMarkers] = await Promise.all([
          fetchJson<HighlightSummary>(`/api/analytics/live/highlights?windowSec=${windowSec}`),
          fetchJson<WindowComparisonSummary>("/api/analytics/live/window-compare"),
          fetchJson<LiveMarkersResponse>("/api/analytics/live/markers")
        ]);
        if (!cancelled && selectedSessionIdRef.current === "live") {
          setHighlightSummary(nextHighlights);
          setWindowComparison(nextComparison);
          setMarkers(nextMarkers.markers);
          setMarkersSessionId(nextMarkers.sessionId);
          setCanSaveMarkers(nextMarkers.canSave);
        }
      } catch {
        // 일시적 오류 — 다음 폴링에서 복구
      }
    }

    void loadLiveDetails();
    const intervalId = window.setInterval(() => void loadLiveDetails(), 5_000);
    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, [selectedSessionId, windowSec]);

  // 사이드바 세션 목록에는 있지만 아직 방송이 끝나지 않은(activeSessions에 포함된) 세션은
  // 계속 채팅이 쌓이므로, 종료된 세션처럼 1회만 조회하면 카운트가 스냅샷에 멈춰버린다.
  const isSelectedSessionActive = useMemo(() => {
    if (selectedSessionId === "live") {
      return false;
    }
    const active = recordingStatus.activeSessions?.length
      ? recordingStatus.activeSessions
      : recordingStatus.activeSession
        ? [recordingStatus.activeSession]
        : [];
    return active.some((session) => session.sessionId === selectedSessionId);
  }, [recordingStatus, selectedSessionId]);

  useEffect(() => {
    if (selectedSessionId === "live") {
      return undefined;
    }
    let cancelled = false;
    const keywordParam = keywords.length > 0 ? `&keywords=${encodeURIComponent(keywords.join(","))}` : "";

    async function loadSessionWindows() {
      try {
        const next = await fetchJson<AnalyticsSummary>(
          `/api/analytics/sessions/${encodeURIComponent(selectedSessionId)}/windows?windowSec=${windowSec}${keywordParam}`
        );
        if (!cancelled) {
          setSessionSummary(next);
        }
      } catch {
        // 일시적 오류 — 진행 중 세션이면 다음 폴링에서, 아니면 재선택 시 복구
      }
    }

    void loadSessionWindows();
    const intervalId = isSelectedSessionActive ? window.setInterval(() => void loadSessionWindows(), 1_000) : undefined;
    return () => {
      cancelled = true;
      if (intervalId !== undefined) {
        window.clearInterval(intervalId);
      }
    };
  }, [selectedSessionId, windowSec, keywords, isSelectedSessionActive]);

  useEffect(() => {
    if (selectedSessionId === "live") {
      return undefined;
    }
    let cancelled = false;

    async function loadSessionDetails() {
      try {
        const [nextHighlights, nextComparison, nextMarkers] = await Promise.all([
          fetchJson<HighlightSummary>(`/api/analytics/sessions/${encodeURIComponent(selectedSessionId)}/highlights?windowSec=${windowSec}`),
          fetchJson<WindowComparisonSummary>(`/api/analytics/sessions/${encodeURIComponent(selectedSessionId)}/window-compare`),
          fetchJson<{ sessionId: string; markers: TimelineMarker[] }>(
            `/api/analytics/sessions/${encodeURIComponent(selectedSessionId)}/markers`
          )
        ]);
        if (!cancelled) {
          setHighlightSummary(nextHighlights);
          setWindowComparison(nextComparison);
          setMarkers(nextMarkers.markers);
          setMarkersSessionId(nextMarkers.sessionId);
          setCanSaveMarkers(true);
        }
      } catch {
        // 일시적 오류 — 진행 중 세션이면 다음 폴링에서 복구
      }
    }

    void loadSessionDetails();
    const intervalId = isSelectedSessionActive ? window.setInterval(() => void loadSessionDetails(), 5_000) : undefined;
    return () => {
      cancelled = true;
      if (intervalId !== undefined) {
        window.clearInterval(intervalId);
      }
    };
  }, [selectedSessionId, windowSec, isSelectedSessionActive]);

  useEffect(() => {
    if (selectedSessionId !== "live") {
      return;
    }
    const thresholds = highlightSummary.thresholds;
    if (thresholds.activeWindowCount < MIN_SPIKE_SAMPLE_WINDOWS || thresholds.p99 <= 0 || thresholds.activeWindowMean <= 0) {
      return;
    }
    const now = Date.now();
    let spike: AnalyticsWindow | undefined;
    for (let index = liveSummary.windows.length - 1; index >= 0; index -= 1) {
      const candidate = liveSummary.windows[index];
      if (now - candidate.windowEnd >= SPIKE_ALERT_MAX_AGE_MS) {
        break;
      }
      if (candidate.messageCount >= thresholds.p99 && candidate.messageCount >= thresholds.activeWindowMean) {
        spike = candidate;
        break;
      }
    }
    if (!spike || spike.windowStart <= lastSpikeWindowRef.current) {
      return;
    }
    lastSpikeWindowRef.current = spike.windowStart;
    const toastId = now;
    const message = `채팅 급증 · ${formatTime(spike.windowStart)} · ${spike.messageCount}개/${liveSummary.windowSec}초`;
    setSpikeToasts((current) => [...current, { id: toastId, message }]);
    window.setTimeout(() => {
      setSpikeToasts((current) => current.filter((toast) => toast.id !== toastId));
    }, SPIKE_TOAST_LIFETIME_MS);
  }, [liveSummary, highlightSummary, selectedSessionId]);

  const summary = selectedSessionId === "live" ? liveSummary : sessionSummary ?? emptySummary;
  const activeSessions = recordingStatus.activeSessions?.length
    ? recordingStatus.activeSessions
    : recordingStatus.activeSession
      ? [recordingStatus.activeSession]
      : [];
  const selectedSession = selectedSessionId === "live" ? activeSessions[0] : sessions.find((session) => session.sessionId === selectedSessionId);
  const visibleSessions = filterSessions(sessions, sessionProviderFilter, sessionDateFilter);
  const selectedMemoCandidate = selectedRange
    ? buildManualCandidate({
        annotations: highlightSummary.annotations,
        range: selectedRange,
        sessionId: highlightSummary.session?.sessionId ?? selectedSession?.sessionId ?? selectedSessionId,
        thresholds: highlightSummary.thresholds,
        windows: summary.windows,
        windowSec
      })
    : undefined;

  const keywordTotals = useMemo(() => {
    if (keywords.length === 0) {
      return {} as Record<string, number>;
    }
    const totals: Record<string, number> = {};
    for (const window of summary.windows) {
      if (!window.keywordCounts) {
        continue;
      }
      for (const [keyword, count] of Object.entries(window.keywordCounts)) {
        totals[keyword] = (totals[keyword] ?? 0) + count;
      }
    }
    return totals;
  }, [summary.windows, keywords]);

  useEffect(() => {
    setDisplayNameDraft(selectedSession && selectedSessionId !== "live" ? selectedSession.displayName ?? "" : "");
    // 세션 목록은 채팅 유입 중 주기적으로 재조회되어 객체 참조가 계속 바뀌므로,
    // 입력 초안은 "선택된 세션 ID가 실제로 바뀔 때"만 리셋한다 (객체 identity 기준 금지)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedSession?.sessionId, selectedSessionId]);

  function addKeywords(event: FormEvent) {
    event.preventDefault();
    const entries = keywordInput
      .split(",")
      .map((keyword) => keyword.trim().toLowerCase())
      .filter(Boolean);
    if (entries.length === 0) {
      return;
    }
    setKeywords((current) => Array.from(new Set([...current, ...entries])).slice(0, MAX_TRACKED_KEYWORDS));
    setKeywordInput("");
  }

  function removeKeyword(keyword: string) {
    setKeywords((current) => current.filter((item) => item !== keyword));
  }

  async function loadSessions() {
    setSessions(await fetchJson<RecordingSession[]>("/api/analytics/sessions"));
  }

  async function resetLive() {
    const next = await fetchJson<AnalyticsSummary>(`/api/analytics/live/reset?windowSec=${windowSec}`, { method: "POST" });
    setLiveSummary(next);
    const [nextHighlights, nextComparison] = await Promise.all([
      fetchJson<HighlightSummary>(`/api/analytics/live/highlights?windowSec=${windowSec}`),
      fetchJson<WindowComparisonSummary>("/api/analytics/live/window-compare")
    ]);
    setHighlightSummary(nextHighlights);
    setWindowComparison(nextComparison);
  }

  async function saveSessionDisplayName() {
    if (!selectedSession || selectedSessionId === "live") {
      return;
    }
    const updated = await fetchJson<RecordingSession>(`/api/analytics/sessions/${encodeURIComponent(selectedSession.sessionId)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ displayName: displayNameDraft })
    });
    setSessions((current) => current.map((session) => (session.sessionId === updated.sessionId ? updated : session)));
  }

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem("chat-theme", theme);
  }, [theme]);

  async function saveAnnotation(candidate: HighlightCandidate, category: HighlightCategory, note: string) {
    if (!highlightSummary.canSaveAnnotations) {
      return;
    }
    setSaveState((current) => ({ ...current, [candidate.id]: "saving" }));
    try {
      const result = await fetchJson<{ annotation: HighlightCandidate["annotation"] }>(
        `/api/analytics/sessions/${encodeURIComponent(candidate.sessionId)}/annotations/${encodeURIComponent(candidate.id)}`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            category,
            note,
            startAt: candidate.startAt,
            endAt: candidate.endAt,
            windowSec: candidate.windowSec,
            peakCount: candidate.peakCount,
            totalMessages: candidate.totalMessages,
            topTerms: candidate.topTerms
          })
        }
      );
      setHighlightSummary((current) => ({
        ...current,
        annotations: result.annotation ? { ...current.annotations, [candidate.id]: result.annotation } : current.annotations,
        candidates: current.candidates.map((item) => (item.id === candidate.id ? { ...item, annotation: result.annotation } : item))
      }));
      setSaveState((current) => ({ ...current, [candidate.id]: "saved" }));
    } catch {
      setSaveState((current) => ({ ...current, [candidate.id]: "error" }));
    }
  }

  async function deleteAnnotation(sessionId: string, candidateId: string) {
    setSaveState((current) => ({ ...current, [candidateId]: "saving" }));
    try {
      await fetchJson<{ deletedCandidateId: string }>(
        `/api/analytics/sessions/${encodeURIComponent(sessionId)}/annotations/${encodeURIComponent(candidateId)}`,
        { method: "DELETE" }
      );
      setHighlightSummary((current) => {
        const { [candidateId]: _deleted, ...annotations } = current.annotations;
        return {
          ...current,
          annotations,
          candidates: current.candidates.map((item) => (item.id === candidateId ? { ...item, annotation: undefined } : item))
        };
      });
      setSaveState((current) => ({ ...current, [candidateId]: "saved" }));
    } catch {
      setSaveState((current) => ({ ...current, [candidateId]: "error" }));
    }
  }

  function clearSelection() {
    setSelectedRange(undefined);
    setFocusRange(undefined);
  }

  async function addMarker(label: string) {
    const trimmed = label.trim().slice(0, 40);
    // 라이브에서는 선택 없이 "지금부터", 구간을 선택했으면 그 시작 시점부터
    const timestamp = selectedRange?.startAt ?? (selectedSessionId === "live" ? Date.now() : undefined);
    if (!trimmed || timestamp === undefined || !canSaveMarkers) {
      return;
    }
    const endpoint =
      selectedSessionId === "live"
        ? "/api/analytics/live/markers"
        : `/api/analytics/sessions/${encodeURIComponent(selectedSessionId)}/markers`;
    try {
      const result = await fetchJson<{ sessionId: string; marker: TimelineMarker }>(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // 구간을 드래그로 지정했으면 그 범위(끝 포함)만 마커로 저장
        body: JSON.stringify({ timestamp, label: trimmed, endAt: selectedRange?.endAt })
      });
      setMarkersSessionId(result.sessionId);
      setMarkers((current) => [...current, result.marker].sort((left, right) => left.timestamp - right.timestamp));
      setMarkerLabelInput("");
    } catch {
      // 실패 시 다음 폴링에서 상태 재동기화
    }
  }

  async function removeMarker(markerId: string) {
    if (!markersSessionId) {
      return;
    }
    try {
      await fetchJson<{ deletedMarkerId: string }>(
        `/api/analytics/sessions/${encodeURIComponent(markersSessionId)}/markers/${encodeURIComponent(markerId)}`,
        { method: "DELETE" }
      );
      setMarkers((current) => current.filter((marker) => marker.id !== markerId));
    } catch {
      // 실패 시 다음 폴링에서 상태 재동기화
    }
  }

  return (
    <main className="admin-shell dashboard-shell">
      <header className="admin-header">
        <div>
          <p className="eyebrow">CHAT ANALYTICS</p>
          <h1>채팅 분석 대시보드</h1>
        </div>
        <div className="admin-header-actions">
          <button
            className="ghost-button"
            onClick={() => setTheme((current) => (current === "light" ? "dark" : "light"))}
            title={theme === "light" ? "다크 모드로 전환" : "라이트 모드로 전환"}
            type="button"
          >
            {theme === "light" ? <Moon size={16} /> : <Sun size={16} />}
            {theme === "light" ? "다크" : "라이트"}
          </button>
          <a className="ghost-button" href="/admin">
            관리 화면
          </a>
          <a className="overlay-link" href="/overlay" target="_blank" rel="noreferrer">
            OBS 오버레이
          </a>
        </div>
      </header>

      <section className="dashboard-layout">
        <aside className="panel session-panel">
          <div className="panel-title">
            <Clock size={20} />
            <h2>세션</h2>
          </div>
          <button className={`session-row ${selectedSessionId === "live" ? "active" : ""}`} onClick={() => setSelectedSessionId("live")}>
            <span>실시간</span>
            <strong>{liveSummary.totalMessages}</strong>
          </button>
          <SessionFilters
            date={sessionDateFilter}
            provider={sessionProviderFilter}
            onDateChange={setSessionDateFilter}
            onProviderChange={setSessionProviderFilter}
          />
          {selectedSessionId !== "live" && selectedSession && (
            <SessionMetaEditor
              displayName={displayNameDraft}
              onDisplayNameChange={setDisplayNameDraft}
              onSave={saveSessionDisplayName}
            />
          )}
          {visibleSessions.map((session) => (
            <button
              className={`session-row ${selectedSessionId === session.sessionId ? "active" : ""}`}
              key={session.sessionId}
              onClick={() => setSelectedSessionId(session.sessionId)}
            >
              <span>{formatSessionName(session)}</span>
              <strong>{session.messageCount}</strong>
            </button>
          ))}
          {visibleSessions.length === 0 && <div className="empty-state compact-empty">조건에 맞는 세션이 없습니다.</div>}
        </aside>

        <section className="dashboard-main">
          <div className="status-strip">
            <div>
              <span className={`status-dot ${activeSessions.length > 0 ? "is-live" : ""}`} />
              {selectedSessionId === "live" ? formatRecordingMessage(recordingStatus, activeSessions) : selectedSession ? "저장 세션" : "세션 없음"}
            </div>
            <div>
              {selectedSessionId === "live"
                ? formatActiveSessions(activeSessions)
                : selectedSession
                  ? `${selectedSession.provider.toUpperCase()} · ${selectedSession.channelId}`
                  : "LIVE"}
            </div>
            {selectedSessionId === "live" && (
              <button className="ghost-button compact-button" onClick={resetLive}>
                <RotateCcw size={16} />
                초기화
              </button>
            )}
            {selectedSessionId !== "live" && selectedSession && (
              <div className="status-strip-export">
                <a
                  className="ghost-button compact-button"
                  href={`/api/analytics/sessions/${encodeURIComponent(selectedSession.sessionId)}/export?format=csv`}
                >
                  <Download size={15} />
                  CSV
                </a>
                <a
                  className="ghost-button compact-button"
                  href={`/api/analytics/sessions/${encodeURIComponent(selectedSession.sessionId)}/export?format=json`}
                >
                  <Download size={15} />
                  JSON
                </a>
              </div>
            )}
          </div>

          <div className="metric-grid">
            <Metric icon={<MessageSquareText size={19} />} label="메시지" value={summary.totalMessages.toLocaleString()} />
            <Metric icon={<Users size={19} />} label="참여자" value={summary.uniqueChatters.toLocaleString()} />
            <Metric
              detail={formatViewerBreakdown(providerViewerCounts)}
              icon={<Eye size={19} />}
              label="시청자"
              value={summary.viewerCount !== undefined ? summary.viewerCount.toLocaleString() : "—"}
            />
            <Metric
              icon={<Percent size={19} />}
              label="참여율(5분)"
              value={summary.participationRate !== undefined ? formatPercent(summary.participationRate) : "—"}
            />
            <Metric icon={<BarChart3 size={19} />} label={`피크/${windowSec}초`} value={String(maxWindow(summary.windows))} />
            <Metric icon={<Hash size={19} />} label="평균 길이" value={String(avgMessageLength(summary.windows))} />
          </div>

          <section className="panel timeline-panel">
            <div className="timeline-toolbar">
              <div className="panel-title">
                <Activity size={20} />
                <h2>{windowSec}초 윈도우</h2>
              </div>
              <div className="window-tabs" role="tablist" aria-label="분석 윈도우 크기">
                {WINDOW_OPTIONS.map((option) => (
                  <button
                    aria-selected={windowSec === option}
                    className={windowSec === option ? "active" : ""}
                    key={option}
                    onClick={() => setWindowSec(option)}
                    role="tab"
                    type="button"
                  >
                    {option}초
                  </button>
                ))}
              </div>
            </div>
            <div className="keyword-tracker">
              <form className="keyword-form" onSubmit={addKeywords}>
                <input
                  value={keywordInput}
                  onChange={(event) => setKeywordInput(event.target.value)}
                  placeholder="추적 키워드 (쉼표로 여러 개)"
                />
                <button className="ghost-button compact-button" type="submit">
                  <Tag size={15} />
                  추적
                </button>
              </form>
              {keywords.length > 0 && (
                <div className="keyword-chip-list">
                  {keywords.map((keyword) => (
                    <button
                      className="keyword-chip"
                      key={keyword}
                      onClick={() => removeKeyword(keyword)}
                      title="클릭하여 추적 해제"
                      type="button"
                    >
                      #{keyword}
                      <strong>{(keywordTotals[keyword] ?? 0).toLocaleString()}</strong>
                      <X size={12} />
                    </button>
                  ))}
                </div>
              )}
            </div>
            <Timeline
              focusRange={focusRange}
              markers={markers}
              participationRate={summary.participationRate}
              selection={selectedRange}
              thresholds={highlightSummary.thresholds}
              windows={summary.windows}
              windowSec={windowSec}
              onSelectionChange={setSelectedRange}
            />
            {canSaveMarkers && (selectedSessionId === "live" || selectedRange) && (
              <form
                className="marker-form"
                onSubmit={(event) => {
                  event.preventDefault();
                  void addMarker(markerLabelInput);
                }}
              >
                <span className="marker-form-hint">
                  {selectedRange ? `${formatTime(selectedRange.startAt)}부터 구간:` : "지금부터 구간:"}
                </span>
                {MARKER_PRESETS.map((preset) => (
                  <button className="ghost-button compact-button" key={preset} onClick={() => void addMarker(preset)} type="button">
                    {preset}
                  </button>
                ))}
                <input
                  value={markerLabelInput}
                  onChange={(event) => setMarkerLabelInput(event.target.value)}
                  placeholder="직접 입력"
                />
                <button className="ghost-button compact-button" type="submit">
                  추가
                </button>
              </form>
            )}
            {markers.length > 0 && (
              <div className="marker-chip-list">
                {markers.map((marker) => (
                  <span className="marker-chip" key={marker.id} style={{ background: markerColor(marker.label) }}>
                    {formatTime(marker.timestamp)} · {marker.label}
                    <button onClick={() => void removeMarker(marker.id)} title="마커 삭제" type="button">
                      <X size={12} />
                    </button>
                  </span>
                ))}
              </div>
            )}
          </section>

          {selectedRange && <FramePlayerPanel range={selectedRange} />}

          <HighlightMemoPanel
            onClearSelection={clearSelection}
            onDeleteAnnotation={deleteAnnotation}
            onFocusAnnotation={(annotation) => {
              const range = getAnnotationRange(annotation);
              if (range) {
                const nextRange = { startAt: range.startAt, endAt: range.endAt };
                setSelectedRange(nextRange);
                setFocusRange(nextRange);
              }
            }}
            selectedCandidate={selectedMemoCandidate}
            summary={highlightSummary}
            saveState={saveState}
            onSave={saveAnnotation}
          />

          <WindowComparisonPanel comparison={windowComparison} />

          <div className="dashboard-columns">
            <section className="panel">
              <div className="panel-title">
                <Users size={20} />
                <h2>상위 채팅러</h2>
              </div>
              <RankList items={summary.topChatters} />
            </section>
            <section className="panel">
              <div className="panel-title">
                <Hash size={20} />
                <h2>상위 단어</h2>
              </div>
              <RankList items={summary.topTerms} />
            </section>
          </div>
        </section>
      </section>
      {spikeToasts.length > 0 && (
        <div className="spike-toast-stack" role="status">
          {spikeToasts.map((toast) => (
            <div className="spike-toast" key={toast.id}>
              <Flame size={15} />
              {toast.message}
            </div>
          ))}
        </div>
      )}
    </main>
  );
}

function mergePartialSummary(current: AnalyticsSummary, incoming: AnalyticsSummary): AnalyticsSummary {
  const { partialWindows: _partial, ...rest } = incoming;
  if (current.windowSec !== incoming.windowSec) {
    // 윈도우 크기 전환 직후 — 전체 윈도우는 REST 재조회가 채우므로 병합하지 않음
    return current;
  }
  if (current.windows.length === 0) {
    return { ...rest };
  }
  const byStart = new Map(current.windows.map((window) => [window.windowStart, window]));
  for (const window of incoming.windows) {
    const previous = byStart.get(window.windowStart);
    byStart.set(
      window.windowStart,
      previous?.keywordCounts && !window.keywordCounts ? { ...window, keywordCounts: previous.keywordCounts } : window
    );
  }
  const windows = Array.from(byStart.values()).sort((left, right) => left.windowStart - right.windowStart);
  return { ...rest, windows };
}

function Metric({ icon, label, value, detail }: { icon: ReactNode; label: string; value: string; detail?: string }) {
  return (
    <div className="metric-tile">
      {icon}
      <span>{label}</span>
      <strong>{value}</strong>
      {detail && <em className="metric-detail">{detail}</em>}
    </div>
  );
}

function formatViewerBreakdown(counts: Partial<Record<"chzzk" | "soop", number>>) {
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

function SessionFilters({
  provider,
  date,
  onProviderChange,
  onDateChange
}: {
  provider: "all" | "chzzk" | "soop";
  date: string;
  onProviderChange(provider: "all" | "chzzk" | "soop"): void;
  onDateChange(date: string): void;
}) {
  return (
    <div className="session-filters">
      <select value={provider} onChange={(event) => onProviderChange(event.target.value as "all" | "chzzk" | "soop")}>
        <option value="all">전체 플랫폼</option>
        <option value="chzzk">CHZZK</option>
        <option value="soop">SOOP</option>
      </select>
      <input value={date} onChange={(event) => onDateChange(event.target.value)} type="date" />
    </div>
  );
}

function SessionMetaEditor({
  displayName,
  onDisplayNameChange,
  onSave
}: {
  displayName: string;
  onDisplayNameChange(value: string): void;
  onSave(): void;
}) {
  return (
    <form
      className="session-meta-editor"
      onSubmit={(event) => {
        event.preventDefault();
        onSave();
      }}
    >
      <label>
        <span>세션 이름 · Enter로 저장</span>
        <input value={displayName} onChange={(event) => onDisplayNameChange(event.target.value)} placeholder="표시 이름" />
      </label>
    </form>
  );
}

function WindowComparisonPanel({
  comparison
}: {
  comparison: WindowComparisonSummary;
}) {
  return (
    <section className="panel comparison-panel">
      <div className="panel-title">
        <BarChart3 size={20} />
        <h2>윈도우 비교</h2>
      </div>
      {comparison.items.length === 0 ? (
        <div className="empty-state compact-empty">비교할 데이터가 없습니다.</div>
      ) : (
        <div className="comparison-grid">
          {comparison.items.map((item) => (
            <div className="comparison-card" key={item.windowSec}>
              <strong>{item.windowSec}초</strong>
              <span>평균 {item.activeWindowMean}</span>
              <span>P95 {item.p95}</span>
              <span>피크 {item.max}</span>
              <span>후보 {item.candidateWindowCount}</span>
              <span>강한 후보 {item.strongCount}</span>
              <em>{item.topScore}x</em>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function markerColor(label: string) {
  return MARKER_COLORS[label] ?? "rgba(170, 185, 178, 0.22)";
}

/** 밀리초 구간(startMs~endMs)에 포함되는 초 단위 프레임 시각 목록 */
function frameSecondsForRange(startMs: number, endMs: number): number[] {
  const startSec = Math.floor(startMs / 1000);
  const endSec = Math.floor((endMs - 1) / 1000);
  const seconds: number[] = [];
  for (let second = startSec; second <= endSec; second += 1) {
    seconds.push(second);
  }
  return seconds;
}

/** 윈도우 구간에 포함되는 초 단위 프레임 시각 목록 — 예: 5초 윈도우 → 5개 */
function frameSecondsForWindow(window: AnalyticsWindow): number[] {
  return frameSecondsForRange(window.windowStart, window.windowEnd);
}

/** 해당 시각의 방송 프레임 — 서버에 프레임이 없으면(404) 조용히 숨김 */
function FramePreview({ second, large }: { second: number; large?: boolean }) {
  const [failedSecond, setFailedSecond] = useState<number | undefined>();
  if (failedSecond === second) {
    return null;
  }
  return (
    <img
      alt=""
      className={large ? "frame-preview frame-preview-large" : "frame-preview"}
      loading="lazy"
      onError={() => setFailedSecond(second)}
      src={`/api/frames/chzzk/${second}.jpg`}
    />
  );
}

/** 선택된 구간을 크게 자동재생 — 호버 미리보기와 별개로, 클릭해서 고른 구간을 명확히 확인하기 위한 패널 */
function FramePlayerPanel({ range }: { range: TimelineSelection }) {
  const [frameIndex, setFrameIndex] = useState(0);
  const seconds = useMemo(() => frameSecondsForRange(range.startAt, range.endAt), [range.startAt, range.endAt]);

  useEffect(() => {
    setFrameIndex(0);
    if (seconds.length <= 1) {
      return undefined;
    }
    const id = window.setInterval(() => {
      setFrameIndex((current) => (current + 1) % seconds.length);
    }, FRAME_PLAYBACK_INTERVAL_MS);
    return () => window.clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [range.startAt, range.endAt]);

  const second = seconds[frameIndex];

  return (
    <section className="panel frame-player-panel">
      <div className="panel-title">
        <Eye size={20} />
        <h2>
          선택 구간 재생 · {formatTime(range.startAt)} ~ {formatTime(range.endAt)}
        </h2>
      </div>
      {second !== undefined ? (
        <>
          <FramePreview large second={second} />
          <div className="frame-player-scrubber">
            {seconds.map((s, index) => (
              <span className={index === frameIndex ? "active" : ""} key={s} />
            ))}
          </div>
        </>
      ) : (
        <div className="empty-state compact-empty">이 구간의 캡처된 화면이 없습니다.</div>
      )}
    </section>
  );
}

function Timeline({
  focusRange,
  markers,
  participationRate,
  selection,
  windows,
  windowSec,
  thresholds,
  onSelectionChange
}: {
  focusRange?: TimelineSelection;
  markers: TimelineMarker[];
  participationRate?: number;
  selection?: TimelineSelection;
  windows: AnalyticsWindow[];
  windowSec: number;
  thresholds: HighlightThresholds;
  onSelectionChange(selection: TimelineSelection): void;
}) {
  const scrollerRef = useRef<HTMLDivElement>(null);
  const [hovered, setHovered] = useState<{ window: AnalyticsWindow; x: number; y: number } | undefined>();
  const [frameIndex, setFrameIndex] = useState(0);
  const [scrollLeft, setScrollLeft] = useState(0);
  const [viewportWidth, setViewportWidth] = useState(760);
  const [followLatest, setFollowLatest] = useState(true);
  const [dragStartIndex, setDragStartIndex] = useState<number | undefined>();
  const [dragEndIndex, setDragEndIndex] = useState<number | undefined>();
  const [showViewerLine, setShowViewerLine] = useState(true);
  const filled = useMemo(() => fillTimelineWindows(windows, windowSec), [windows, windowSec]);
  const totalWidth = Math.max(1, filled.length * SLOT_WIDTH);
  const maxCount = useMemo(() => filled.reduce((best, window) => Math.max(best, window.messageCount), 1), [filled]);
  const viewerValues = useMemo(() => {
    let lastKnown: number | undefined;
    return filled.map((window) => {
      if (window.viewerCount !== undefined) {
        lastKnown = window.viewerCount;
      }
      return lastKnown;
    });
  }, [filled]);
  const maxViewer = useMemo(
    () => viewerValues.reduce<number>((best, value) => Math.max(best, value ?? 0), 0),
    [viewerValues]
  );
  const markerSegments = useMemo(() => {
    if (filled.length === 0 || markers.length === 0) {
      return [];
    }
    const windowMs = Math.max(1, Math.round(windowSec)) * 1000;
    const firstStart = filled[0].windowStart;
    const toX = (timestamp: number) => Math.min(totalWidth, Math.max(0, ((timestamp - firstStart) / windowMs) * SLOT_WIDTH));
    return markers.map((marker, index) => {
      const x = toX(marker.timestamp);
      // 끝이 지정된 마커는 그 범위까지만, 아니면 다음 마커(없으면 현재)까지
      const end = marker.endAt ?? (index + 1 < markers.length ? markers[index + 1].timestamp : undefined);
      const nextX = end !== undefined ? toX(end) : totalWidth;
      return { id: marker.id, label: marker.label, x, width: Math.max(0, nextX - x) };
    });
  }, [filled, markers, windowSec, totalWidth]);
  const firstVisible = filled[clampIndex(Math.floor(scrollLeft / SLOT_WIDTH), filled.length)];
  const lastVisible = filled[clampIndex(Math.ceil((scrollLeft + viewportWidth) / SLOT_WIDTH) - 1, filled.length)];

  useEffect(() => {
    setFollowLatest(true);
  }, [windowSec]);

  useEffect(() => {
    // windowStart로 키를 잡아서 같은 막대 안에서 마우스가 움직여도(hovered 객체 자체는
    // 매번 새로 생성됨) 재생이 처음부터 다시 시작되지 않고, 다른 막대로 옮겨갈 때만 리셋된다.
    setFrameIndex(0);
    if (!hovered) {
      return undefined;
    }
    const frameSeconds = frameSecondsForWindow(hovered.window);
    if (frameSeconds.length <= 1) {
      return undefined;
    }
    const id = window.setInterval(() => {
      setFrameIndex((current) => (current + 1) % frameSeconds.length);
    }, FRAME_PLAYBACK_INTERVAL_MS);
    return () => window.clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hovered?.window.windowStart]);

  useEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller) {
      return undefined;
    }
    const updateWidth = () => setViewportWidth(scroller.clientWidth);
    updateWidth();
    const observer = new ResizeObserver(updateWidth);
    observer.observe(scroller);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!followLatest) {
      return;
    }
    const scroller = scrollerRef.current;
    if (scroller) {
      scroller.scrollLeft = scroller.scrollWidth;
    }
  }, [followLatest, totalWidth]);

  useEffect(() => {
    if (!focusRange) {
      return;
    }
    const scroller = scrollerRef.current;
    if (!scroller) {
      return;
    }
    const focusIndex = filled.findIndex((window) => window.windowStart < focusRange.endAt && window.windowEnd > focusRange.startAt);
    if (focusIndex < 0) {
      return;
    }
    setFollowLatest(false);
    scroller.scrollLeft = Math.max(0, focusIndex * SLOT_WIDTH - scroller.clientWidth / 2);
  }, [focusRange]);

  useEffect(() => {
    if (dragStartIndex === undefined) {
      return undefined;
    }

    const stopDragging = () => {
      setDragStartIndex(undefined);
      setDragEndIndex(undefined);
    };
    window.addEventListener("mouseup", stopDragging);
    return () => {
      window.removeEventListener("mouseup", stopDragging);
    };
  }, [dragStartIndex]);

  if (filled.length === 0) {
    return <div className="empty-state">표시할 채팅이 없습니다.</div>;
  }

  function handleScroll() {
    const scroller = scrollerRef.current;
    if (!scroller) {
      return;
    }
    setScrollLeft(scroller.scrollLeft);
    setFollowLatest(scroller.scrollLeft + scroller.clientWidth >= scroller.scrollWidth - SLOT_WIDTH);
  }

  function showTooltip(event: MouseEvent<SVGRectElement>, window: AnalyticsWindow) {
    const bounds = scrollerRef.current?.getBoundingClientRect();
    if (!bounds) {
      return;
    }
    setHovered({
      window,
      x: Math.min(Math.max(event.clientX - bounds.left, 112), bounds.width - 112),
      y: Math.max(event.clientY - bounds.top - 14, 18)
    });
  }

  function emitSelection(leftIndex: number, rightIndex: number) {
    const startIndex = Math.min(leftIndex, rightIndex);
    const endIndex = Math.max(leftIndex, rightIndex);
    const firstWindow = filled[startIndex];
    const lastWindow = filled[endIndex];
    if (!firstWindow || !lastWindow) {
      return;
    }
    onSelectionChange({ startAt: firstWindow.windowStart, endAt: lastWindow.windowEnd });
  }

  function startDrag(absoluteIndex: number) {
    setDragStartIndex(absoluteIndex);
    setDragEndIndex(absoluteIndex);
    emitSelection(absoluteIndex, absoluteIndex);
  }

  function updateDrag(absoluteIndex: number) {
    if (dragStartIndex === undefined) {
      return;
    }
    setDragEndIndex(absoluteIndex);
    emitSelection(dragStartIndex, absoluteIndex);
  }

  function isSelected(window: AnalyticsWindow, absoluteIndex: number) {
    const selectedByRange = Boolean(selection && window.windowStart < selection.endAt && window.windowEnd > selection.startAt);
    if (dragStartIndex === undefined || dragEndIndex === undefined) {
      return selectedByRange;
    }
    return (
      selectedByRange ||
      (absoluteIndex >= Math.min(dragStartIndex, dragEndIndex) && absoluteIndex <= Math.max(dragStartIndex, dragEndIndex))
    );
  }

  const firstRenderIndex = Math.max(0, Math.floor(scrollLeft / SLOT_WIDTH) - RENDER_BUFFER_SLOTS);
  const lastRenderIndex = Math.min(filled.length, Math.ceil((scrollLeft + viewportWidth) / SLOT_WIDTH) + RENDER_BUFFER_SLOTS);
  const rendered = filled.slice(firstRenderIndex, lastRenderIndex);

  const hoveredFrameSeconds = hovered ? frameSecondsForWindow(hovered.window) : [];
  const hoveredFrameSecond = hoveredFrameSeconds[frameIndex] ?? hoveredFrameSeconds[0];

  return (
    <div className="timeline-chart-wrap">
      {participationRate !== undefined && (
        <div className="timeline-participation-badge">
          <Percent size={13} />
          참여율 {formatPercent(participationRate)}
        </div>
      )}
      {maxViewer > 0 && (
        <button
          className={`timeline-viewer-legend ${showViewerLine ? "" : "is-off"}`}
          onClick={() => setShowViewerLine((current) => !current)}
          title={showViewerLine ? "시청자 추이 숨기기" : "시청자 추이 표시"}
          type="button"
        >
          <Eye size={13} />
          시청자 추이 · 최대 {maxViewer.toLocaleString()}명
        </button>
      )}
      <div className="timeline-scroller" onScroll={handleScroll} ref={scrollerRef}>
        <svg className="timeline-chart" width={totalWidth} height={CHART_HEIGHT} role="img" aria-label={`${windowSec}초 윈도우 채팅량`}>
          {rendered.map((window, index) => {
            const absoluteIndex = firstRenderIndex + index;
            const x = absoluteIndex * SLOT_WIDTH;
            const barHeight = window.messageCount === 0 ? 2 : Math.max(4, (window.messageCount / maxCount) * (CHART_HEIGHT - 30));
            const y = CHART_HEIGHT - barHeight - CHART_BOTTOM_PAD;
            const level = getWindowVisualLevel(window, thresholds);
            return (
              <g key={window.windowStart}>
                <rect
                  className={`bar level-${level} ${hovered?.window.windowStart === window.windowStart ? "active" : ""} ${isSelected(window, absoluteIndex) ? "is-selected" : ""}`}
                  height={barHeight}
                  rx="2"
                  width={BAR_WIDTH}
                  x={x}
                  y={y}
                />
                <rect
                  aria-label={`${formatWindowRange(window)} 메시지 ${window.messageCount}개`}
                  className="bar-hit"
                  height={CHART_HEIGHT - CHART_BOTTOM_PAD}
                  onMouseDown={(event) => {
                    event.preventDefault();
                    startDrag(absoluteIndex);
                  }}
                  onMouseEnter={(event) => showTooltip(event, window)}
                  onMouseLeave={() => setHovered(undefined)}
                  onMouseMove={(event) => {
                    showTooltip(event, window);
                    updateDrag(absoluteIndex);
                  }}
                  onMouseUp={() => updateDrag(absoluteIndex)}
                  width={SLOT_WIDTH}
                  x={x - BAR_GAP / 2}
                  y={0}
                >
                  <title>{`${formatWindowRange(window)} · 메시지 ${window.messageCount}개`}</title>
                </rect>
                {absoluteIndex % TIME_LABEL_SLOT_INTERVAL === 0 && (
                  <text x={x} y={CHART_HEIGHT - 4}>
                    {formatTime(window.windowStart)}
                  </text>
                )}
              </g>
            );
          })}
          {markerSegments.map((segment) => (
            <g className="marker-group" key={segment.id}>
              {segment.width > 0 && segment.label !== MARKER_END_LABEL && (
                <rect className="marker-band" fill={markerColor(segment.label)} height={16} width={segment.width} x={segment.x} y={0} />
              )}
              <line className="marker-line" x1={segment.x} x2={segment.x} y1={0} y2={CHART_HEIGHT - CHART_BOTTOM_PAD} />
              {segment.label !== MARKER_END_LABEL && (
                <text className="marker-label" x={segment.x + 5} y={12}>
                  {segment.label}
                </text>
              )}
            </g>
          ))}
          {showViewerLine && maxViewer > 0 && (
            <polyline
              className="viewer-trend-line"
              fill="none"
              points={rendered
                .map((window, index) => {
                  const absoluteIndex = firstRenderIndex + index;
                  const value = viewerValues[absoluteIndex];
                  if (value === undefined) {
                    return undefined;
                  }
                  const x = absoluteIndex * SLOT_WIDTH + BAR_WIDTH / 2;
                  const y = CHART_HEIGHT - CHART_BOTTOM_PAD - (value / maxViewer) * (CHART_HEIGHT - 40);
                  return `${x},${Math.round(y * 10) / 10}`;
                })
                .filter((point): point is string => Boolean(point))
                .join(" ")}
            />
          )}
        </svg>
      </div>
      {hovered && (
        <div className="timeline-tooltip" style={{ left: hovered.x, top: hovered.y }}>
          {hoveredFrameSecond !== undefined && <FramePreview second={hoveredFrameSecond} />}
          <strong>{formatWindowRange(hovered.window)}</strong>
          <span>메시지 {hovered.window.messageCount.toLocaleString()}개</span>
          <span>참여자 {hovered.window.uniqueChatters.toLocaleString()}명</span>
          {hovered.window.viewerCount !== undefined && <span>시청자 {hovered.window.viewerCount.toLocaleString()}명</span>}
          {hovered.window.viewerCount ? (
            <span>참여율 {formatPercent(hovered.window.uniqueChatters / hovered.window.viewerCount)}</span>
          ) : null}
          {hovered.window.keywordCounts &&
            Object.entries(hovered.window.keywordCounts).map(([keyword, count]) => (
              <span key={keyword}>
                #{keyword} {count}
              </span>
            ))}
          <span>{formatWindowLevel(hovered.window, thresholds)}</span>
        </div>
      )}
      <div className="timeline-scrollbar">
        <span>
          {firstVisible && lastVisible ? `${formatTime(firstVisible.windowStart)} ~ ${formatTime(lastVisible.windowEnd)}` : ""}
        </span>
        {!followLatest && (
          <button className="ghost-button compact-button" onClick={() => setFollowLatest(true)} type="button">
            최신 보기
          </button>
        )}
      </div>
    </div>
  );
}

function clampIndex(index: number, length: number) {
  return Math.min(Math.max(0, length - 1), Math.max(0, index));
}

function fillTimelineWindows(windows: AnalyticsWindow[], windowSec: number): AnalyticsWindow[] {
  if (windows.length < 2) {
    return windows;
  }
  const windowMs = Math.max(1, Math.round(windowSec)) * 1000;
  const first = windows[0];
  const last = windows[windows.length - 1];
  const slotCount = Math.round((last.windowStart - first.windowStart) / windowMs) + 1;
  if (!Number.isFinite(slotCount) || slotCount <= windows.length || slotCount > MAX_FILLED_SLOTS) {
    return windows;
  }
  const byStart = new Map(windows.map((window) => [window.windowStart, window]));
  return Array.from({ length: slotCount }, (_, index) => {
    const windowStart = first.windowStart + index * windowMs;
    return byStart.get(windowStart) ?? emptyTimelineWindow(windowStart, windowMs);
  });
}

function emptyTimelineWindow(windowStart: number, windowMs: number): AnalyticsWindow {
  return {
    windowStart,
    windowEnd: windowStart + windowMs,
    messageCount: 0,
    uniqueChatters: 0,
    avgLength: 0,
    maxLength: 0,
    providerCounts: {},
    roleCounts: {},
    topChatters: [],
    topTerms: [],
    topEmotes: []
  };
}

function formatPercent(rate: number) {
  return `${Math.round(rate * 1000) / 10}%`;
}

type WindowVisualLevel = HighlightLevel | "below";

function HighlightMemoPanel({
  summary,
  selectedCandidate,
  saveState,
  onClearSelection,
  onDeleteAnnotation,
  onFocusAnnotation,
  onSave
}: {
  summary: HighlightSummary;
  selectedCandidate?: HighlightCandidate;
  saveState: Record<string, "saving" | "saved" | "error">;
  onClearSelection(): void;
  onDeleteAnnotation(sessionId: string, candidateId: string): Promise<void>;
  onFocusAnnotation(annotation: HighlightAnnotation): void;
  onSave(candidate: HighlightCandidate, category: HighlightCategory, note: string): Promise<void>;
}) {
  const savedAnnotations = getSavedAnnotations(summary.annotations);
  const annotationSessionId = summary.session?.sessionId;

  return (
    <section className="panel highlight-panel">
      <div className="highlight-panel-header">
        <div className="panel-title">
          <Flame size={20} />
          <h2>하이라이트 메모</h2>
        </div>
        <div className="threshold-strip">
          <span>평균 {summary.thresholds.activeWindowMean}</span>
          <span>P95 {summary.thresholds.p95}</span>
          <span>P99 {summary.thresholds.p99}</span>
          <strong>{savedAnnotations.length}개 메모</strong>
          {selectedCandidate && (
            <button className="ghost-button compact-button clear-selection-button" onClick={onClearSelection} type="button">
              <X size={15} />
              선택 해제
            </button>
          )}
        </div>
      </div>

      {!summary.canSaveAnnotations && (
        <div className="highlight-save-notice">
          <Tag size={16} />
          저장 가능한 세션 없음
        </div>
      )}

      {selectedCandidate ? (
        <HighlightMemoEditor
          candidate={selectedCandidate}
          canSave={summary.canSaveAnnotations}
          saveState={saveState[selectedCandidate.id]}
          onClearSelection={onClearSelection}
          onDelete={selectedCandidate.annotation ? () => onDeleteAnnotation(selectedCandidate.sessionId, selectedCandidate.id) : undefined}
          onSave={onSave}
        />
      ) : (
        <div className="empty-state compact-empty">선택된 윈도우 구간이 없습니다.</div>
      )}

      <div className="saved-memo-section">
        <h3>저장된 메모</h3>
        {savedAnnotations.length === 0 ? (
          <div className="empty-state compact-empty">저장된 메모가 없습니다.</div>
        ) : (
          <div className="saved-memo-list">
            {savedAnnotations.map((annotation) => (
              <SavedMemoRow
                annotation={annotation}
                canDelete={Boolean(annotationSessionId)}
                key={annotation.candidateId}
                onDelete={annotationSessionId ? () => onDeleteAnnotation(annotationSessionId, annotation.candidateId) : undefined}
                onFocus={onFocusAnnotation}
              />
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

function SavedMemoRow({
  annotation,
  canDelete,
  onDelete,
  onFocus
}: {
  annotation: HighlightAnnotation;
  canDelete: boolean;
  onDelete?(): void;
  onFocus(annotation: HighlightAnnotation): void;
}) {
  const range = getAnnotationRange(annotation);

  return (
    <div className="saved-memo-row">
      <button className="saved-memo-focus" onClick={() => onFocus(annotation)} type="button">
        <div>
          <strong>{range ? `${formatTime(range.startAt)} ~ ${formatTime(range.endAt)}` : annotation.candidateId}</strong>
          <span>
            {categoryLabel(annotation.category)}
            {range ? ` · ${range.windowSec}초` : ""}
          </span>
        </div>
        {(annotation.peakCount !== undefined || annotation.totalMessages !== undefined) && (
          <div className="saved-memo-meta">
            {annotation.peakCount !== undefined && <span>Peak {annotation.peakCount}</span>}
            {annotation.totalMessages !== undefined && <span>총 {annotation.totalMessages}</span>}
            {annotation.topTerms?.slice(0, 3).map((term) => (
              <span key={term.label}>{term.label}</span>
            ))}
          </div>
        )}
        <p>{annotation.note || "메모 없음"}</p>
      </button>
      <button className="ghost-button compact-button memo-delete-button" disabled={!canDelete} onClick={onDelete} type="button">
        <Trash2 size={15} />
        삭제
      </button>
    </div>
  );
}

function HighlightMemoEditor({
  candidate,
  canSave,
  saveState,
  onClearSelection,
  onDelete,
  onSave
}: {
  candidate: HighlightCandidate;
  canSave: boolean;
  saveState?: "saving" | "saved" | "error";
  onClearSelection(): void;
  onDelete?(): void;
  onSave(candidate: HighlightCandidate, category: HighlightCategory, note: string): Promise<void>;
}) {
  const [category, setCategory] = useState<HighlightCategory>(candidate.annotation?.category ?? "other");
  const [note, setNote] = useState(candidate.annotation?.note ?? "");

  useEffect(() => {
    setCategory(candidate.annotation?.category ?? "other");
    setNote(candidate.annotation?.note ?? "");
  }, [candidate.annotation?.category, candidate.annotation?.note, candidate.id]);

  function submit(event: FormEvent) {
    event.preventDefault();
    void onSave(candidate, category, note);
  }

  return (
    <form className={`highlight-row memo-editor-row level-${candidate.level}`} onSubmit={submit}>
      <div className="highlight-main">
        <div className="highlight-time">
          <LevelBadge level={candidate.level} />
          <strong>{formatCandidateRange(candidate)}</strong>
          <span>{formatDuration(candidate.durationSec)}</span>
        </div>
        <div className="highlight-stats">
          <span>Peak {candidate.peakCount}</span>
          <span>{candidate.score}x</span>
          <span>참여자 {candidate.uniqueChatters}</span>
          <span>총 {candidate.totalMessages}</span>
        </div>
        <div className="term-chip-list">
          {candidate.topTerms.length === 0 ? (
            <span className="muted-chip">단어 없음</span>
          ) : (
            candidate.topTerms.map((term) => (
              <span className="term-chip" key={term.label}>
                {term.label} {term.count}
              </span>
            ))
          )}
        </div>
      </div>
      <div className="highlight-editor">
        <select disabled={!canSave} value={category} onChange={(event) => setCategory(event.target.value as HighlightCategory)}>
          {HIGHLIGHT_CATEGORIES.map((item) => (
            <option key={item.value} value={item.value}>
              {item.label}
            </option>
          ))}
        </select>
        <input disabled={!canSave} value={note} onChange={(event) => setNote(event.target.value)} placeholder="어떤 하이라이트였는지 메모" />
        <button className="ghost-button compact-button" disabled={!canSave || saveState === "saving"} type="submit">
          <Save size={15} />
          {saveState === "saving" ? "저장 중" : saveState === "saved" ? "저장됨" : saveState === "error" ? "실패" : "저장"}
        </button>
        {onDelete && (
          <button className="ghost-button compact-button memo-delete-button" disabled={saveState === "saving"} onClick={onDelete} type="button">
            <Trash2 size={15} />
            삭제
          </button>
        )}
        <button className="ghost-button compact-button" onClick={onClearSelection} type="button">
          <X size={15} />
          해제
        </button>
      </div>
    </form>
  );
}

function buildManualCandidate({
  annotations,
  range,
  sessionId,
  thresholds,
  windows,
  windowSec
}: {
  annotations: HighlightSummary["annotations"];
  range: TimelineSelection;
  sessionId: string;
  thresholds: HighlightThresholds;
  windows: AnalyticsWindow[];
  windowSec: number;
}): HighlightCandidate {
  const selectedWindows = windows.filter((window) => window.windowStart < range.endAt && window.windowEnd > range.startAt);
  const peakCount = Math.max(0, ...selectedWindows.map((window) => window.messageCount));
  const totalMessages = selectedWindows.reduce((sum, window) => sum + window.messageCount, 0);
  const uniqueChatters = Math.max(0, ...selectedWindows.map((window) => window.uniqueChatters));
  const score = thresholds.activeWindowMean > 0 ? Math.round((peakCount / thresholds.activeWindowMean) * 10) / 10 : 0;
  const id = `${sessionId}-${windowSec}-${range.startAt}-${range.endAt}`;

  return {
    id,
    sessionId,
    windowSec,
    level: levelFromPeak(peakCount, thresholds),
    startAt: range.startAt,
    endAt: range.endAt,
    durationSec: Math.max(windowSec, Math.round((range.endAt - range.startAt) / 1000)),
    peakCount,
    totalMessages,
    uniqueChatters,
    score,
    topTerms: mergeRankItems(selectedWindows, "topTerms"),
    topEmotes: mergeRankItems(selectedWindows, "topEmotes"),
    annotation: annotations[id]
  };
}

function mergeRankItems(windows: AnalyticsWindow[], key: "topTerms" | "topEmotes") {
  const counts = new Map<string, AnalyticsRankItem>();
  for (const window of windows) {
    for (const item of window[key]) {
      const current = counts.get(item.label);
      counts.set(item.label, {
        id: item.id ?? current?.id,
        label: item.label,
        count: (current?.count ?? 0) + item.count
      });
    }
  }
  return Array.from(counts.values())
    .sort((a, b) => b.count - a.count)
    .slice(0, 5);
}

function levelFromPeak(peakCount: number, thresholds: HighlightThresholds): HighlightLevel {
  if (thresholds.p99 > 0 && peakCount >= thresholds.p99) {
    return "strong";
  }
  if (thresholds.p95 > 0 && peakCount >= thresholds.p95) {
    return "highlight";
  }
  return "review";
}

function getSavedAnnotations(annotations: HighlightSummary["annotations"]) {
  return Object.values(annotations).sort((a, b) => {
    const left = getAnnotationRange(a)?.startAt ?? a.updatedAt;
    const right = getAnnotationRange(b)?.startAt ?? b.updatedAt;
    return left - right;
  });
}

function getAnnotationRange(annotation: HighlightAnnotation) {
  if (annotation.startAt !== undefined && annotation.endAt !== undefined && annotation.windowSec !== undefined) {
    return {
      startAt: annotation.startAt,
      endAt: annotation.endAt,
      windowSec: annotation.windowSec
    };
  }

  const parts = annotation.candidateId.split("-");
  const endAt = Number(parts.at(-1));
  const startAt = Number(parts.at(-2));
  const windowSec = Number(parts.at(-3));
  if (!Number.isFinite(startAt) || !Number.isFinite(endAt) || !Number.isFinite(windowSec)) {
    return undefined;
  }
  return { startAt, endAt, windowSec };
}

function categoryLabel(category: HighlightCategory) {
  return HIGHLIGHT_CATEGORIES.find((item) => item.value === category)?.label ?? "기타";
}

function LevelBadge({ level }: { level: HighlightLevel }) {
  return <span className={`level-badge level-${level}`}>{levelLabel(level)}</span>;
}

function getWindowVisualLevel(window: AnalyticsWindow, thresholds: HighlightThresholds): WindowVisualLevel {
  if (thresholds.activeWindowMean <= 0 || window.messageCount < thresholds.activeWindowMean) {
    return "below";
  }
  if (window.messageCount >= thresholds.p99) {
    return "strong";
  }
  if (window.messageCount >= thresholds.p95) {
    return "highlight";
  }
  return "review";
}

function formatWindowLevel(window: AnalyticsWindow, thresholds: HighlightThresholds) {
  const level = getWindowVisualLevel(window, thresholds);
  if (level === "below") {
    return "평균 이하";
  }
  const score = thresholds.activeWindowMean > 0 ? Math.round((window.messageCount / thresholds.activeWindowMean) * 10) / 10 : 0;
  return `${levelLabel(level)} · 평균 대비 ${score}x`;
}

function levelLabel(level: HighlightLevel) {
  if (level === "strong") {
    return "강한 후보";
  }
  if (level === "highlight") {
    return "하이라이트";
  }
  return "검토";
}

function formatCandidateRange(candidate: HighlightCandidate) {
  return `${formatTime(candidate.startAt)} ~ ${formatTime(candidate.endAt)}`;
}

function formatDuration(durationSec: number) {
  return `${durationSec}초`;
}

function RankList({ items }: { items: AnalyticsRankItem[] }) {
  const max = Math.max(1, ...items.map((item) => item.count));
  if (items.length === 0) {
    return <div className="empty-state">데이터 없음</div>;
  }

  return (
    <div className="rank-list">
      {items.map((item) => (
        <div className="rank-row" key={item.label}>
          <span>{item.label}</span>
          <div className="rank-bar">
            <i style={{ width: `${Math.max(6, (item.count / max) * 100)}%` }} />
          </div>
          <strong>{item.count}</strong>
        </div>
      ))}
    </div>
  );
}

function maxWindow(windows: AnalyticsWindow[]) {
  return Math.max(0, ...windows.map((window) => window.messageCount));
}

function avgMessageLength(windows: AnalyticsWindow[]) {
  const totals = windows.reduce(
    (acc, window) => {
      acc.sum += window.avgLength * window.messageCount;
      acc.count += window.messageCount;
      return acc;
    },
    { sum: 0, count: 0 }
  );
  return totals.count ? Math.round((totals.sum / totals.count) * 10) / 10 : 0;
}

function formatRecordingMessage(status: RecordingStatus, activeSessions: RecordingSession[]) {
  if (activeSessions.length === 0) {
    return status.message;
  }
  return `${activeSessions.map((session) => session.provider.toUpperCase()).join(" · ")} 저장 중`;
}

function formatActiveSessions(activeSessions: RecordingSession[]) {
  if (activeSessions.length === 0) {
    return "LIVE";
  }
  return activeSessions.map((session) => `${session.provider.toUpperCase()} · ${session.channelId}`).join(" / ");
}

function formatSessionName(session: RecordingSession) {
  if (session.displayName) {
    return `${session.displayName} · ${session.provider.toUpperCase()}`;
  }
  return `${formatDate(session.startedAt)} · ${session.provider.toUpperCase()} · ${session.channelId}`;
}

function filterSessions(sessions: RecordingSession[], provider: "all" | "chzzk" | "soop", date: string) {
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

function formatTime(timestamp: number) {
  return new Intl.DateTimeFormat("ko-KR", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  }).format(timestamp);
}

function formatWindowRange(window: AnalyticsWindow) {
  return `${formatTime(window.windowStart)} ~ ${formatTime(window.windowEnd)}`;
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  if (!response.ok) {
    throw new Error(`Request failed: ${response.status}`);
  }
  return (await response.json()) as T;
}
