import type { OffsetSegment } from "./types";

/**
 * offset 부호 규약의 단일 진실원 (부호 민감 변환은 이 파일 한 곳에만 둔다).
 *
 *   anchorTime = soopTime + offsetMs
 *
 * offsetMs는 SOOP(target) 시각을 치지직(anchor) 축으로 옮기는 이동량이다.
 * SOOP이 8초 늦게 찍히면(soopTime = anchorTime + 8000) offsetMs = −8000.
 * 서버 finalize 재작성과 라이브 표시 보정이 이 두 함수를 공유한다.
 */

/**
 * 주어진 시각에 적용할 offset(ms)을 구간 목록에서 고른다. 구간이 없으면 0(무보정).
 * 첫 구간 앞/마지막 구간 뒤는 각각 첫·마지막 구간으로 클램프해 선두·후미를 backfill한다
 * (offset은 구간 길이보다 훨씬 작아 조회 축이 soop/anchor 어느 쪽이어도 경계 오차는 무해).
 */
export function offsetAtTime(segments: OffsetSegment[], time: number): number {
  if (segments.length === 0) {
    return 0;
  }
  const first = segments[0];
  if (time < first.startAt) {
    return first.offsetMs;
  }
  for (const segment of segments) {
    if (time >= segment.startAt && time < segment.endAt) {
      return segment.offsetMs;
    }
  }
  return segments[segments.length - 1].offsetMs;
}

/** SOOP 시각을 anchor(치지직) 축으로 변환한다. anchorTime = soopTime + offsetMs. */
export function toAnchorTimestamp(soopTime: number, segments: OffsetSegment[]): number {
  return soopTime + offsetAtTime(segments, soopTime);
}
