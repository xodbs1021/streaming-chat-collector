import { Eye } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { AnalyticsWindow, ChatProvider } from "../../../shared/types";
import type { FrameCaptureStatus } from "../../../shared/frameCaptureStatus";
import { filterAvailableSeconds, otherProvider, resolveAvailableFrames, resolvePrimaryProvider, sumProviderCounts } from "../../frameProviderSelection";
import { FRAME_PLAYBACK_INTERVAL_MS, PROVIDER_LABEL, type TimelineSelection } from "./constants";
import { formatFrameTimestamp, formatTime, frameSecondsForRange } from "./format";
import { FramePreview } from "./FramePreview";

/** 선택된 구간을 크게 자동재생 — 호버 미리보기와 별개로, 클릭해서 고른 구간을 명확히 확인하기 위한 패널 */
export function FramePlayerPanel({
  range,
  windows,
  frameBroadcastId,
  frameSecondsByProvider,
  frameCaptureStatusByProvider,
  frameIndexLoaded,
  sessionProvider
}: {
  range: TimelineSelection;
  windows: AnalyticsWindow[];
  /** 종료된 과거 세션이면 그 방송 id — 프레임을 과거 방송 주소로 읽는다(없으면 라이브). */
  frameBroadcastId?: string;
  frameSecondsByProvider: Partial<Record<ChatProvider, number[]>>;
  frameCaptureStatusByProvider?: Partial<Record<ChatProvider, FrameCaptureStatus>>;
  frameIndexLoaded: boolean;
  /** 세션 탭이면 그 세션의 provider — 채팅 없는 빈 구간의 프레임 폴백에 쓴다(라이브는 undefined). */
  sessionProvider?: ChatProvider;
}) {
  const [frameIndex, setFrameIndex] = useState(0);
  const [manualProvider, setManualProvider] = useState<ChatProvider | undefined>();
  const candidateSeconds = useMemo(() => frameSecondsForRange(range.startAt, range.endAt), [range.startAt, range.endAt]);
  const rangeWindows = useMemo(
    () => windows.filter((window) => window.windowStart < range.endAt && window.windowEnd > range.startAt),
    [windows, range.startAt, range.endAt]
  );
  const rangeCounts = useMemo(() => sumProviderCounts(rangeWindows), [rangeWindows]);
  const dominant = resolvePrimaryProvider(rangeCounts, sessionProvider);

  // 실제 캡처된 프레임만 남긴다 — 인덱스를 아직 못 받았으면(초기 로드) 옛 방식(이론상 초 전부)으로 우선 표시.
  // 사용자가 탭으로 플랫폼을 직접 골랐으면 그 선택을 그대로 존중하고(자동 폴백 없음), 안 골랐으면
  // 채팅량이 더 많은 플랫폼을 우선 시도하되 실제 프레임이 없으면 반대쪽을 시도한다.
  const resolved = useMemo(() => {
    if (!frameIndexLoaded) {
      return { provider: manualProvider ?? dominant, seconds: candidateSeconds };
    }
    if (manualProvider) {
      return { provider: manualProvider, seconds: filterAvailableSeconds(candidateSeconds, frameSecondsByProvider[manualProvider] ?? []) };
    }
    return resolveAvailableFrames(candidateSeconds, frameSecondsByProvider, dominant, otherProvider(dominant));
  }, [frameIndexLoaded, manualProvider, dominant, candidateSeconds, frameSecondsByProvider]);

  const activeProvider = resolved.provider;
  const seconds = resolved.seconds;
  const captureStatus = frameCaptureStatusByProvider?.[activeProvider];
  const captureReason = captureStatus && captureStatus.state !== "idle" ? captureStatus.message : undefined;

  useEffect(() => {
    setFrameIndex(0);
    setManualProvider(undefined);
  }, [range.startAt, range.endAt]);

  useEffect(() => {
    if (seconds.length <= 1) {
      return undefined;
    }
    const id = window.setInterval(() => {
      setFrameIndex((current) => (current + 1) % seconds.length);
    }, FRAME_PLAYBACK_INTERVAL_MS);
    return () => window.clearInterval(id);
  }, [seconds]);

  const activeIndex = seconds.length > 0 ? frameIndex % seconds.length : -1;
  const second = activeIndex >= 0 ? seconds[activeIndex] : undefined;

  return (
    <section className="panel frame-player-panel">
      <div className="panel-title">
        <Eye size={20} />
        <h2>
          선택 구간 재생 · {formatTime(range.startAt)} ~ {formatTime(range.endAt)}
        </h2>
        <div className="frame-player-provider-tabs" role="tablist" aria-label="프레임 플랫폼">
          {(["chzzk", "soop"] as const).map((provider) => (
            <button
              aria-selected={activeProvider === provider}
              className={activeProvider === provider ? "active" : ""}
              key={provider}
              onClick={() => setManualProvider(provider)}
              role="tab"
              type="button"
            >
              {PROVIDER_LABEL[provider]}
            </button>
          ))}
        </div>
        {captureStatus && captureReason && <span className={`capture-badge capture-${captureStatus.state}`}>{captureReason}</span>}
      </div>
      {second !== undefined ? (
        <>
          {/* key는 provider 단위 — 프레임(second)마다 remount하면 <img>가 새로 생겨 로드 전 빈 화면이 깜빡인다 */}
          <FramePreview key={activeProvider} broadcastId={frameBroadcastId} large provider={activeProvider} second={second} />
          <time className="frame-timestamp" dateTime={new Date(second * 1000).toISOString()}>
            {formatFrameTimestamp(second)}
          </time>
          {/* 사진 1장당 점 1개는 구간이 크면 수백 개로 늘어나 UI를 늘려버린다 → 고정 크기 요약 텍스트로 대체 */}
          <p className="frame-player-summary">
            {formatFrameTimestamp(seconds[0])} ~ {formatFrameTimestamp(seconds[seconds.length - 1])} · 총 {seconds.length}장
          </p>
        </>
      ) : (
        <div className="empty-state compact-empty">이 구간의 캡처된 화면이 없습니다.{captureReason ? ` (${captureReason})` : ""}</div>
      )}
    </section>
  );
}
