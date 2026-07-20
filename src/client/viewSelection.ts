/**
 * 대시보드가 지금 무엇을 보고 있는지 파싱하는 순수 모듈 — selectedSessionId 하나로 세 뷰를 구분한다.
 *   "live"                     → 라이브(여러 방송 병합 통합 화면)
 *   "<broadcastId>__merged"    → 과거 방송의 합쳐 보기(양 provider 채팅 병합)
 *   "<broadcastId>__<provider>"→ 과거 방송의 단일 provider 세션
 *
 * `__merged`는 서버 parseSessionKey가 provider로 인정하지 않아, 세션 API로 오배선되면 404로 격리된다.
 */

export const LIVE_VIEW_ID = "live";
const MERGED_SUFFIX = "__merged";

export type ViewSelection =
  | { kind: "live" }
  | { kind: "merged"; broadcastId: string }
  | { kind: "session"; sessionId: string };

/** 합쳐 보기 뷰의 센티넬 id. */
export function mergedViewId(broadcastId: string): string {
  return `${broadcastId}${MERGED_SUFFIX}`;
}

/** selectedSessionId를 뷰 종류로 판별한다. */
export function parseViewSelection(id: string): ViewSelection {
  if (id === LIVE_VIEW_ID) {
    return { kind: "live" };
  }
  if (id.endsWith(MERGED_SUFFIX)) {
    const broadcastId = id.slice(0, -MERGED_SUFFIX.length);
    if (broadcastId) {
      return { kind: "merged", broadcastId };
    }
  }
  return { kind: "session", sessionId: id };
}
