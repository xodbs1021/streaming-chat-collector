import type { ChatProvider } from "../../shared/types";

const SEPARATOR = "__";

/**
 * (broadcastId, provider)를 라우트·저장에서 단일 문자열로 지목하기 위한 합성 키.
 * 구분자는 `__` — sanitize가 `_`를 보존(`\w`)하므로 파일명·URL 파라미터에 안전하다.
 */
export function composeSessionKey(broadcastId: string, provider: ChatProvider): string {
  return `${broadcastId}${SEPARATOR}${provider}`;
}

export interface ParsedSessionKey {
  broadcastId: string;
  provider: ChatProvider;
}

/** 합성 세션 키를 broadcastId/provider로 되돌린다. 형식이 아니면 undefined. */
export function parseSessionKey(sessionId: string): ParsedSessionKey | undefined {
  const index = sessionId.lastIndexOf(SEPARATOR);
  if (index <= 0) {
    return undefined;
  }
  const broadcastId = sessionId.slice(0, index);
  const provider = sessionId.slice(index + SEPARATOR.length);
  if (provider !== "chzzk" && provider !== "soop") {
    return undefined;
  }
  return { broadcastId, provider };
}
