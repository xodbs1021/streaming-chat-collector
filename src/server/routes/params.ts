// HTTP 쿼리/바디 파라미터 파서 — 여러 라우트 그룹에서 공유한다.

export function readWindowSec(input: string | undefined) {
  const value = Number(input ?? 5);
  return Number.isFinite(value) ? value : 5;
}

export function readKeywords(input: string | undefined) {
  if (!input) {
    return [];
  }
  return input
    .split(",")
    .map((keyword) => keyword.trim())
    .filter(Boolean)
    .slice(0, 8);
}

export function readOptionalNumber(input: unknown) {
  if (input === undefined || input === null) {
    return undefined;
  }
  const value = Number(input);
  return Number.isFinite(value) ? value : undefined;
}
