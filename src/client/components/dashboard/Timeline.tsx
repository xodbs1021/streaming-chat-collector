import { Eye, Percent } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { MouseEvent } from "react";
import type { AnalyticsWindow, ChatProvider, HighlightThresholds, TimelineMarker } from "../../../shared/types";
import { dominantProvider, otherProvider, resolveAvailableFrames } from "../../frameProviderSelection";
import {
  BAR_GAP,
  BAR_WIDTH,
  CHART_BOTTOM_PAD,
  CHART_HEIGHT,
  FRAME_PLAYBACK_INTERVAL_MS,
  MARKER_END_LABEL,
  MAX_FILLED_SLOTS,
  RENDER_BUFFER_SLOTS,
  SLOT_WIDTH,
  TIME_LABEL_SLOT_INTERVAL,
  type TimelineSelection
} from "./constants";
import { formatFrameTimestamp, formatPercent, formatTime, formatWindowRange, frameSecondsForWindow, markerColor } from "./format";
import { formatWindowLevel, getWindowVisualLevel } from "./highlight";
import { FramePreview } from "./FramePreview";

export function Timeline({
  focusRange,
  frameIndexLoaded,
  frameSecondsByProvider,
  markers,
  participationRate,
  selection,
  windows,
  windowSec,
  thresholds,
  onSelectionChange
}: {
  focusRange?: TimelineSelection;
  frameIndexLoaded: boolean;
  frameSecondsByProvider: Partial<Record<ChatProvider, number[]>>;
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
  const frameAvailabilityRef = useRef({ byProvider: frameSecondsByProvider, loaded: frameIndexLoaded });
  frameAvailabilityRef.current = { byProvider: frameSecondsByProvider, loaded: frameIndexLoaded };
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
    // frameSecondsByProvider의 5초 폴링 자체는 이 effect를 재시작시키지 않도록 ref로 최신값만 읽는다.
    setFrameIndex(0);
    if (!hovered) {
      return undefined;
    }
    const candidateSeconds = frameSecondsForWindow(hovered.window);
    const primary = dominantProvider(hovered.window.providerCounts) ?? "chzzk";
    const { loaded, byProvider } = frameAvailabilityRef.current;
    const frameCount = loaded
      ? resolveAvailableFrames(candidateSeconds, byProvider, primary, otherProvider(primary)).seconds.length
      : candidateSeconds.length;
    if (frameCount <= 1) {
      return undefined;
    }
    const id = window.setInterval(() => {
      setFrameIndex((current) => (current + 1) % frameCount);
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

  const hoveredCandidateSeconds = hovered ? frameSecondsForWindow(hovered.window) : [];
  const hoveredPrimaryProvider = hovered ? (dominantProvider(hovered.window.providerCounts) ?? "chzzk") : "chzzk";
  const hoveredResolved = frameIndexLoaded
    ? resolveAvailableFrames(hoveredCandidateSeconds, frameSecondsByProvider, hoveredPrimaryProvider, otherProvider(hoveredPrimaryProvider))
    : { provider: hoveredPrimaryProvider, seconds: hoveredCandidateSeconds };
  const hoveredFrameSeconds = hoveredResolved.seconds;
  const hoveredFrameSecond = hoveredFrameSeconds[frameIndex % Math.max(hoveredFrameSeconds.length, 1)] ?? hoveredFrameSeconds[0];
  const hoveredProvider = hoveredResolved.provider;

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
          {hoveredFrameSecond !== undefined && (
            <FramePreview
              key={`${hoveredProvider}-${hoveredFrameSecond}`}
              fallbackProvider={otherProvider(hoveredProvider)}
              provider={hoveredProvider}
              second={hoveredFrameSecond}
            />
          )}
          {hoveredFrameSecond !== undefined && (
            <time className="frame-timestamp" dateTime={new Date(hoveredFrameSecond * 1000).toISOString()}>
              {formatFrameTimestamp(hoveredFrameSecond)}
            </time>
          )}
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
