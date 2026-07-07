const BASE_DELAY_MS = 1_000;
const MAX_DELAY_MS = 30_000;

/** 지수 백오프 재연결 지연 — 시도 1회차부터 2배씩 증가, 30초에서 상한 */
export function computeReconnectDelayMs(attempt: number): number {
  const safeAttempt = Math.max(1, Math.round(attempt));
  return Math.min(BASE_DELAY_MS * 2 ** safeAttempt, MAX_DELAY_MS);
}
