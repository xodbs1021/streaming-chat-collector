import type { FastifyInstance } from "fastify";
import { readFile } from "node:fs/promises";
import type { BroadcastOffset, ChatRecord, ViewerCountSample } from "../../shared/types";
import { summarizeChatRecords, summarizeHighlightCandidates } from "../analytics";
import { ChatRecorder } from "../recorder";
import { BroadcastPaths } from "../broadcast/broadcastPaths";
import { isValidBroadcastId } from "../broadcast/broadcastId";
import { composeSessionKey } from "../broadcast/sessionKey";
import { readKeywords, readWindowSec } from "./params";

interface BroadcastRouteDeps {
  recorder: ChatRecorder;
  paths: BroadcastPaths;
}

const MERGE_PROVIDERS = ["chzzk", "soop"] as const;

/**
 * 병합(합쳐 보기) 조회 라우트 — 방송의 양 provider 채팅을 **단순 concat**해 기존 요약을 재사용한다.
 * 파일은 이미 finalize가 anchor 축으로 정렬해 뒀으므로 화면 쪽 축 변환이 없다(그냥 합치기).
 * 이번 PR은 읽기 전용(마커·window-compare·메모 저장은 provider 세션에 묶여 범위 밖).
 * 검증·오류 코드는 과거 프레임 라우트(/api/broadcasts/:id/frames)와 대칭.
 */
export function registerBroadcastRoutes(app: FastifyInstance, deps: BroadcastRouteDeps) {
  const { recorder, paths } = deps;

  /** 양 provider 채팅을 합친다(정렬은 summarizeChatRecords가 내부에서 수행하므로 순서 무관). */
  async function readMergedRecords(broadcastId: string): Promise<ChatRecord[]> {
    const perProvider = await Promise.all(
      MERGE_PROVIDERS.map((provider) => recorder.readRecords(composeSessionKey(broadcastId, provider)))
    );
    return perProvider.flat();
  }

  async function readMergedViewerSamples(broadcastId: string): Promise<ViewerCountSample[]> {
    const perProvider = await Promise.all(
      MERGE_PROVIDERS.map((provider) => recorder.readViewerSamples(composeSessionKey(broadcastId, provider)))
    );
    return perProvider.flat();
  }

  app.get<{ Params: { broadcastId: string }; Querystring: { windowSec?: string; keywords?: string } }>(
    "/api/broadcasts/:broadcastId/windows",
    async (request, reply) => {
      if (!isValidBroadcastId(request.params.broadcastId)) {
        return reply.code(400).send({ error: "잘못된 방송 id입니다." });
      }
      const [records, viewerSamples] = await Promise.all([
        readMergedRecords(request.params.broadcastId),
        readMergedViewerSamples(request.params.broadcastId)
      ]);
      if (records.length === 0) {
        return reply.code(404).send({ error: "해당 방송의 채팅을 찾지 못했습니다." });
      }
      return summarizeChatRecords(records, readWindowSec(request.query.windowSec), undefined, viewerSamples, readKeywords(request.query.keywords));
    }
  );

  app.get<{ Params: { broadcastId: string }; Querystring: { windowSec?: string } }>(
    "/api/broadcasts/:broadcastId/highlights",
    async (request, reply) => {
      if (!isValidBroadcastId(request.params.broadcastId)) {
        return reply.code(400).send({ error: "잘못된 방송 id입니다." });
      }
      const records = await readMergedRecords(request.params.broadcastId);
      if (records.length === 0) {
        return reply.code(404).send({ error: "해당 방송의 채팅을 찾지 못했습니다." });
      }
      // session 미지정 → canSaveAnnotations=false(병합 탭은 읽기 전용, 주석은 provider 세션에만 저장).
      return summarizeHighlightCandidates(records, readWindowSec(request.query.windowSec), undefined, {}, false);
    }
  );

  app.get<{ Params: { broadcastId: string } }>("/api/broadcasts/:broadcastId/offset", async (request, reply) => {
    if (!isValidBroadcastId(request.params.broadcastId)) {
      return reply.code(400).send({ error: "잘못된 방송 id입니다." });
    }
    const offset = await readOffsetMarker(paths.offsetFilePath(request.params.broadcastId));
    if (!offset) {
      return reply.code(404).send({ error: "보정 기록이 없습니다." });
    }
    return offset;
  });
}

/** offset.json 마커를 읽는다(계산 없음). 부재/불량이면 undefined → 라우트 404. */
async function readOffsetMarker(filePath: string): Promise<BroadcastOffset | undefined> {
  try {
    const parsed = JSON.parse(await readFile(filePath, "utf8")) as BroadcastOffset;
    return parsed?.anchor === "chzzk" && Array.isArray(parsed.segments) ? parsed : undefined;
  } catch {
    return undefined;
  }
}
