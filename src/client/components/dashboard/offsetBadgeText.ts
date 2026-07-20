import type { BroadcastOffset, LiveOffsetStatus, OffsetSegment } from "../../../shared/types";

export type OffsetBadgeTone = "estimating" | "known" | "none";

export interface OffsetBadgeView {
  tone: OffsetBadgeTone;
  text: string;
}

/** offsetMs를 사람이 읽는 초로. anchorTime = soopTime + offsetMs라 음수 = SOOP이 늦음. */
export function formatOffsetSeconds(offsetMs: number): string {
  const seconds = offsetMs / 1000;
  const sign = seconds < 0 ? "-" : "+";
  return `${sign}${Math.abs(seconds).toFixed(1)}초`;
}

/** 라이브 배지 — 소켓 offset:live 상태에서. 꺼져 있으면 "보정 꺼짐", 추정 전이면 "싱크 계산 중". */
export function liveOffsetBadge(status: LiveOffsetStatus | undefined): OffsetBadgeView {
  if (status && !status.enabled) {
    return { tone: "none", text: "보정 꺼짐" };
  }
  if (!status || status.estimating || status.offsetMs === undefined) {
    return { tone: "estimating", text: "싱크 계산 중" };
  }
  return { tone: "known", text: `SOOP 싱크 ${formatOffsetSeconds(status.offsetMs)}` };
}

/**
 * 병합(과거 방송) 배지 — offset.json에서. 활성(녹화 중) 방송은 아직 미정렬이라 "방송 진행 중 — 종료 후 정렬".
 * 마커가 없으면 "보정 기록 없음", 있으면 대표 offset(최고 신뢰 구간)과 구간 수·추정(carried) 수를 요약한다.
 */
export function mergedOffsetBadge(offset: BroadcastOffset | undefined, isActive: boolean): OffsetBadgeView {
  if (isActive) {
    return { tone: "estimating", text: "방송 진행 중 — 종료 후 정렬" };
  }
  if (!offset || offset.segments.length === 0) {
    return { tone: "none", text: "보정 기록 없음" };
  }
  const representative = mostConfidentSegment(offset.segments);
  const carriedCount = offset.segments.filter((segment) => segment.carried).length;
  const carriedSuffix = carriedCount > 0 ? `(추정 ${carriedCount})` : "";
  return {
    tone: "known",
    text: `SOOP 싱크 ${formatOffsetSeconds(representative.offsetMs)} · 구간 ${offset.segments.length}${carriedSuffix}`
  };
}

/** 대표 구간 = 신뢰도가 가장 높은 구간(동률이면 먼저 나온 것). */
function mostConfidentSegment(segments: OffsetSegment[]): OffsetSegment {
  return segments.reduce((best, segment) => (segment.confidence > best.confidence ? segment : best), segments[0]);
}
