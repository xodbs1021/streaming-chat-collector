import type { OffsetSegment } from "./types";

/**
 * offset 부호 규약의 단일 진실원 (부호 민감 변환은 이 파일 한 곳에만 둔다).
 *
 *   anchorTime = soopTime + offsetMs
 *
 * offsetMs는 SOOP(target) 시각을 치지직(anchor) 축으로 옮기는 이동량이다.
 * SOOP이 8초 늦게 찍히면(soopTime = anchorTime + 8000) offsetMs = −8000.
 * 서버 finalize 재작성과 라이브 표시 보정이 이 두 함수를 공유한다.
 *
 * **구간 축 정의:** OffsetSegment.startAt/endAt은 **anchor(치지직) 축** 시각이다(추정 타일이 chzzk 축에서 잘린다).
 * raw SOOP 시각으로 멤버십을 판정하면 경계 부근에서 어긋나므로, offsetAtTime은 "각 구간의 offset을 적용한
 * 시각(soopRaw + offset = anchor)이 그 구간 범위에 드는가"라는 고정점으로 판정한다. offset(초)이 구간
 * 길이(600초)보다 훨씬 작아 이 고정점은 사실상 유일하다.
 */

/**
 * 주어진 SOOP raw 시각에 적용할 offset(ms)을 구간 목록에서 고른다. 구간이 없으면 0(무보정).
 * 고정점 판정: `soopRaw + segment.offsetMs`(= anchor 시각)가 그 구간 [startAt, endAt)에 드는 구간을 고른다.
 * 어느 구간에도 안 들면(선두/후미/경계 미세 갭) 클램프 — 첫 구간 앞이면 첫, 그 외엔 마지막 구간으로 backfill.
 */
export function offsetAtTime(segments: OffsetSegment[], time: number): number {
  if (segments.length === 0) {
    return 0;
  }
  for (const segment of segments) {
    const anchor = time + segment.offsetMs;
    if (anchor >= segment.startAt && anchor < segment.endAt) {
      return segment.offsetMs;
    }
  }
  const first = segments[0];
  if (time + first.offsetMs < first.startAt) {
    return first.offsetMs;
  }
  return segments[segments.length - 1].offsetMs;
}

/** SOOP 시각을 anchor(치지직) 축으로 변환한다. anchorTime = soopTime + offsetMs. */
export function toAnchorTimestamp(soopTime: number, segments: OffsetSegment[]): number {
  return soopTime + offsetAtTime(segments, soopTime);
}
