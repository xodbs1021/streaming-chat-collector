import { readFile, rename, writeFile } from "node:fs/promises";
import type { BroadcastOffset, ChatRecord, OffsetEstimatorParams } from "../../shared/types";
import { toAnchorTimestamp } from "../../shared/offset";
import { BroadcastPaths } from "../broadcast/broadcastPaths";
import { DEFAULT_ESTIMATOR_PARAMS, estimateOffsetSegments } from "./offsetEstimator";

const OFFSET_VERSION = 1;

export interface FinalizeAlignmentDeps {
  paths: BroadcastPaths;
  /** 추정기 파라미터 — 미지정 시 기본(600/1/60/60). offset.json에 그대로 박혀 재현성을 준다. */
  params?: OffsetEstimatorParams;
  now?: () => number;
}

/**
 * 방송 종료 시 SOOP chat.jsonl을 anchor(치지직) 축으로 일괄 재작성하고 `offset.json` 마커를 남긴다.
 * 내구성 경로(임시 파일→rename 원자 교체). 재작성은 **timestamp만** 옮기고 라인 순서·sequence·receivedAt은
 * 그대로 둔다(downstream summarizeChatRecords가 어차피 재정렬). offset.json이 이미 있으면 재적용하지 않는다(멱등).
 *
 * @returns 적용된(또는 기존) BroadcastOffset. 정렬 불가(한쪽 provider 부재·상관 신뢰 0) → undefined(마커 미생성).
 */
export async function finalizeBroadcastAlignment(
  broadcastId: string,
  deps: FinalizeAlignmentDeps
): Promise<BroadcastOffset | undefined> {
  const { paths, params = DEFAULT_ESTIMATOR_PARAMS, now = Date.now } = deps;

  // 멱등 가드 — 마커가 있으면 이미 정렬된 방송이므로 재작성하지 않고 기존 offset을 돌려준다.
  const existing = await readOffsetMarker(paths.offsetFilePath(broadcastId));
  if (existing) {
    return existing;
  }

  const chzzkRecords = await readChatRecords(paths.chatFilePath(broadcastId, "chzzk"));
  const soopRecords = await readChatRecords(paths.chatFilePath(broadcastId, "soop"));
  if (soopRecords.length === 0 || chzzkRecords.length === 0) {
    return undefined; // 한쪽 provider만 있으면 정렬할 게 없다.
  }

  const segments = estimateOffsetSegments(
    chzzkRecords.map((record) => record.timestamp),
    soopRecords.map((record) => record.timestamp),
    params
  );
  if (segments.length === 0) {
    return undefined; // 신뢰 구간 0개 = 정렬 불가(마커 미생성 → 병합 뷰가 "보정 기록 없음").
  }

  // SOOP만 재작성한다(치지직은 anchor라 불변). timestamp만 anchor 축으로 옮기고 나머지 필드·순서는 보존.
  const rewritten = soopRecords
    .map((record) => JSON.stringify({ ...record, timestamp: toAnchorTimestamp(record.timestamp, segments) }))
    .join("\n");
  await atomicWrite(paths.chatFilePath(broadcastId, "soop"), `${rewritten}\n`);

  const offset: BroadcastOffset = {
    version: OFFSET_VERSION,
    anchor: "chzzk",
    target: "soop",
    computedAt: now(),
    params,
    segments
  };
  // 마커는 재작성 성공 뒤에 쓴다 — 마커 존재가 "정렬 완료"의 단일 신호(멱등 가드).
  await atomicWrite(paths.offsetFilePath(broadcastId), `${JSON.stringify(offset, null, 2)}\n`);
  return offset;
}

async function readOffsetMarker(filePath: string): Promise<BroadcastOffset | undefined> {
  try {
    const parsed = JSON.parse(await readFile(filePath, "utf8")) as BroadcastOffset;
    return parsed?.anchor === "chzzk" && Array.isArray(parsed.segments) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

async function readChatRecords(filePath: string): Promise<ChatRecord[]> {
  try {
    const content = await readFile(filePath, "utf8");
    return content
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => parseRecord(line))
      .filter((record): record is ChatRecord => Boolean(record));
  } catch {
    return [];
  }
}

function parseRecord(line: string): ChatRecord | undefined {
  try {
    const parsed = JSON.parse(line) as ChatRecord;
    return parsed?.messageId && Number.isFinite(parsed.timestamp) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** 임시 파일에 쓴 뒤 rename으로 원자 교체 — 재작성 도중 크래시가 원본을 반쯤 덮어쓰지 않게 한다. */
async function atomicWrite(filePath: string, content: string): Promise<void> {
  const tempPath = `${filePath}.tmp`;
  await writeFile(tempPath, content, "utf8");
  await rename(tempPath, filePath);
}
