import { Activity, BarChart3, Download, Eye, Hash, MessageSquareText, Percent, RotateCcw, Tag, Users, X } from "lucide-react";
import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import type {
  AnalyticsSummary,
  AnalyticsWindow,
  ChatProvider,
  HighlightAnnotation,
  HighlightCandidate,
  HighlightCategory,
  HighlightSummary,
  ProviderStatusMap,
  RecordingSession,
  RecordingStatus,
  TimelineMarker,
  WindowComparisonSummary
} from "../../shared/types";
import { fetchFrameSeconds } from "../frameIndexClient";
import { socket } from "../socket";
import { fetchJson } from "./dashboard/api";
import { avgMessageLength, maxWindow, mergePartialSummary } from "./dashboard/analytics";
import {
  FRAME_INDEX_REFRESH_MS,
  MARKER_PRESETS,
  MAX_TRACKED_KEYWORDS,
  MIN_SPIKE_SAMPLE_WINDOWS,
  SESSIONS_REFRESH_THROTTLE_MS,
  SPIKE_ALERT_MAX_AGE_MS,
  SPIKE_TOAST_LIFETIME_MS,
  WINDOW_OPTIONS,
  type TimelineSelection
} from "./dashboard/constants";
import { DashboardHeader } from "./dashboard/DashboardHeader";
import { emptyComparison, emptyHighlightSummary, emptySummary, initialRecordingStatus } from "./dashboard/defaults";
import {
  filterSessions,
  formatActiveSessions,
  formatPercent,
  formatRecordingMessage,
  formatTime,
  formatViewerBreakdown,
  markerColor
} from "./dashboard/format";
import { FramePlayerPanel } from "./dashboard/FramePlayerPanel";
import { buildManualCandidate, getAnnotationRange } from "./dashboard/highlight";
import { HighlightMemoPanel } from "./dashboard/HighlightMemoPanel";
import { Metric, RankList, WindowComparisonPanel } from "./dashboard/panels";
import { SessionSidebar } from "./dashboard/SessionSidebar";
import { SpikeToasts } from "./dashboard/SpikeToasts";
import { Timeline } from "./dashboard/Timeline";

interface LiveMarkersResponse {
  sessionId?: string;
  canSave: boolean;
  markers: TimelineMarker[];
}

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
  const [frameSecondsByProvider, setFrameSecondsByProvider] = useState<Partial<Record<ChatProvider, number[]>>>({});
  const [frameIndexLoaded, setFrameIndexLoaded] = useState(false);
  const windowSecRef = useRef(windowSec);
  const selectedSessionIdRef = useRef(selectedSessionId);
  const lastSpikeWindowRef = useRef(0);
  const summaryWindowsRef = useRef<AnalyticsWindow[]>([]);

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
    // 5초마다 실제로 캡처된 프레임 초 목록을 가져온다 — 화면(호버/재생 패널)은 이 목록에
    // 있는 초만 보여줘서, ffmpeg 재연결로 생긴 캡처 공백에서 이미지가 깜빡이지 않게 한다.
    let cancelled = false;

    async function refreshFrameIndex() {
      const windows = summaryWindowsRef.current;
      if (windows.length === 0) {
        return;
      }
      const fromSec = windows[0].windowStart / 1000;
      const toSec = windows[windows.length - 1].windowEnd / 1000;
      const [chzzk, soop] = await Promise.all([fetchFrameSeconds("chzzk", fromSec, toSec), fetchFrameSeconds("soop", fromSec, toSec)]);
      if (!cancelled) {
        setFrameSecondsByProvider({ chzzk, soop });
        setFrameIndexLoaded(true);
      }
    }

    void refreshFrameIndex();
    const intervalId = window.setInterval(() => void refreshFrameIndex(), FRAME_INDEX_REFRESH_MS);
    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
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
      window.clearInterval(intervalId);
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
  summaryWindowsRef.current = summary.windows;
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
      <DashboardHeader theme={theme} onToggleTheme={() => setTheme((current) => (current === "light" ? "dark" : "light"))} />

      <section className="dashboard-layout">
        <SessionSidebar
          dateFilter={sessionDateFilter}
          displayNameDraft={displayNameDraft}
          liveTotalMessages={liveSummary.totalMessages}
          providerFilter={sessionProviderFilter}
          selectedSession={selectedSession}
          selectedSessionId={selectedSessionId}
          visibleSessions={visibleSessions}
          onDateChange={setSessionDateFilter}
          onDisplayNameChange={setDisplayNameDraft}
          onProviderChange={setSessionProviderFilter}
          onSaveDisplayName={saveSessionDisplayName}
          onSelectSession={setSelectedSessionId}
        />

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
              frameIndexLoaded={frameIndexLoaded}
              frameSecondsByProvider={frameSecondsByProvider}
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

          {selectedRange && (
            <FramePlayerPanel
              frameIndexLoaded={frameIndexLoaded}
              frameSecondsByProvider={frameSecondsByProvider}
              range={selectedRange}
              windows={summary.windows}
            />
          )}

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
      <SpikeToasts toasts={spikeToasts} />
    </main>
  );
}
