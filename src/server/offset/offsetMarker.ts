import { readFile } from "node:fs/promises";
import type { BroadcastOffset } from "../../shared/types";

/**
 * `offset.json` 마커를 읽는다(계산 없음). 부재/불량이면 undefined.
 * finalize의 멱등 가드와 병합 조회 라우트가 공유하는 단일 진실원 — 파싱 관례가 한 곳에만 있게 한다.
 */
export async function readOffsetMarker(filePath: string): Promise<BroadcastOffset | undefined> {
  try {
    const parsed = JSON.parse(await readFile(filePath, "utf8")) as BroadcastOffset;
    return parsed?.anchor === "chzzk" && Array.isArray(parsed.segments) ? parsed : undefined;
  } catch {
    return undefined;
  }
}
