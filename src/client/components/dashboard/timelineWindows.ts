import type { AnalyticsWindow } from "../../../shared/types";
import { MAX_FILLED_SLOTS } from "./constants";

/**
 * 타임라인 윈도우 배열을 연속 슬롯으로 물질화한다 — 서버 라이브 windows는 메시지가 있는 버킷만
 * 존재하므로, 사이의 빈 구간을 emptyTimelineWindow로 채워 축이 균등한 시간 간격을 갖게 한다.
 *
 * `padToMs`(라이브 뷰에서만 전달 — 현재 시각)가 주어지면 마지막 실측 윈도우 이후의 빈 구간도
 * 그 시각의 버킷까지 연장한다. 채팅이 끊겨도(라이브 windows에 새 버킷이 안 생겨도) 축이 현재까지
 * 자라, 방금 캡처된 프레임 구간을 확인할 수 있다. 미지정이면 과거·병합 뷰로 보고 트레일링 연장 없음.
 */
export function fillTimelineWindows(windows: AnalyticsWindow[], windowSec: number, padToMs?: number): AnalyticsWindow[] {
  if (windows.length === 0) {
    return windows;
  }
  const windowMs = Math.max(1, Math.round(windowSec)) * 1000;
  const first = windows[0];
  const last = windows[windows.length - 1];
  // 라이브면 현재 시각 버킷까지, 아니면 마지막 실측 윈도우까지가 축의 끝.
  const lastStart =
    padToMs === undefined ? last.windowStart : Math.max(last.windowStart, Math.floor(padToMs / windowMs) * windowMs);
  const span = Math.round((lastStart - first.windowStart) / windowMs) + 1;
  if (!Number.isFinite(span) || span <= windows.length) {
    return windows;
  }

  let firstStart = first.windowStart;
  let slotCount = span;
  if (span > MAX_FILLED_SLOTS) {
    // 상한 초과. padToMs 없는 과거/병합 뷰는 기존 동작 그대로 — 원본을 두고 연장을 포기한다.
    if (padToMs === undefined) {
      return windows;
    }
    // 라이브 트레일링 연장이 상한을 넘는 경우(1초 윈도우 기준 ~13.9시간의 침묵)는, 축을 마지막
    // 채팅에 얼려두면(연장 포기) 바로 이 버그가 재현된다. 상한의 목적은 배열 크기·렌더 비용 방어이므로,
    // 라이브에서 사용자가 보는 '최근 구간'을 유지하도록 오래된 앞쪽을 잘라 상한 개수만 남긴다.
    slotCount = MAX_FILLED_SLOTS;
    firstStart = lastStart - (MAX_FILLED_SLOTS - 1) * windowMs;
  }

  const byStart = new Map(windows.map((window) => [window.windowStart, window]));
  return Array.from({ length: slotCount }, (_, index) => {
    const windowStart = firstStart + index * windowMs;
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
