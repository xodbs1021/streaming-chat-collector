import { randomBytes } from "node:crypto";

/**
 * 방송 세션 디렉토리 이름으로 쓸 broadcastId를 만든다.
 * 형식: `<YYYYMMDD-HHMMSS>-<6hex>` (예: 20260714-153012-a1b2c3).
 * 앞부분(로컬시각)은 정렬·가독을 주고, 뒤 6hex는 같은 초에 시작한 방송끼리의 충돌을 막는다.
 */
export function createBroadcastId(now: Date = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  const stamp =
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `${stamp}-${randomBytes(3).toString("hex")}`;
}
