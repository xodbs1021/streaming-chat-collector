import type { FastifyInstance } from "fastify";
import { createReadStream } from "node:fs";
import type { FrameIndexResponse } from "../../shared/types";
import { isValidBroadcastId } from "../broadcast/broadcastId";
import { BroadcastFrameReader } from "../broadcast/broadcastFrameReader";
import { FrameCaptureManager } from "../frameCapture";
import { readOptionalNumber } from "./params";

interface FrameRouteDeps {
  frameManagers: Record<"chzzk" | "soop", FrameCaptureManager>;
  frameReader: BroadcastFrameReader;
}

export function registerFrameRoutes(app: FastifyInstance, deps: FrameRouteDeps) {
  const { frameManagers, frameReader } = deps;

  function frameManagerFor(provider: string): FrameCaptureManager | undefined {
    return provider === "chzzk" || provider === "soop" ? frameManagers[provider] : undefined;
  }

  /** 과거 방송 라우트용 provider 닫힌 합집합 검사 — frameManagerFor와 동일 관례(그 외 404). */
  function broadcastProviderFor(provider: string): "chzzk" | "soop" | undefined {
    return provider === "chzzk" || provider === "soop" ? provider : undefined;
  }

  app.get<{ Params: { provider: string } }>("/api/frames/:provider/status", async (request, reply) => {
    const manager = frameManagerFor(request.params.provider);
    if (!manager) {
      return reply.code(404).send({ error: "지원하지 않는 provider입니다." });
    }
    return { ...manager.getDebugState(), capture: manager.getCaptureStatus() };
  });

  app.get<{ Params: { provider: string }; Querystring: { from?: string; to?: string } }>(
    "/api/frames/:provider/index",
    async (request, reply) => {
      const manager = frameManagerFor(request.params.provider);
      if (!manager) {
        return reply.code(404).send({ error: "지원하지 않는 provider입니다." });
      }
      const from = readOptionalNumber(request.query.from) ?? 0;
      const to = readOptionalNumber(request.query.to) ?? Number.MAX_SAFE_INTEGER;
      return { seconds: manager.listFrameSeconds(Math.floor(from), Math.floor(to)) };
    }
  );

  app.get<{ Params: { provider: string; second: string } }>("/api/frames/:provider/:second", async (request, reply) => {
    const manager = frameManagerFor(request.params.provider);
    if (!manager) {
      return reply.code(404).send({ error: "지원하지 않는 provider입니다." });
    }
    const second = Number(request.params.second.replace(/\.jpg$/i, ""));
    if (!Number.isFinite(second)) {
      return reply.code(400).send({ error: "잘못된 시각입니다." });
    }
    const match = manager.nearestFrame(Math.floor(second));
    if (match === undefined) {
      return reply.code(404).send({ error: "해당 시각의 프레임이 없습니다." });
    }
    return reply
      .type("image/jpeg")
      .header("Cache-Control", "public, max-age=86400")
      .send(createReadStream(manager.framePath(match)));
  });

  // ── 과거 방송 프레임 (읽기 전용 — 라이브 라우트와 응답 shape·오류 코드 대칭) ──────────

  app.get<{ Params: { broadcastId: string; provider: string }; Querystring: { from?: string; to?: string } }>(
    "/api/broadcasts/:broadcastId/frames/:provider/index",
    async (request, reply) => {
      if (!isValidBroadcastId(request.params.broadcastId)) {
        return reply.code(400).send({ error: "잘못된 방송 id입니다." });
      }
      const provider = broadcastProviderFor(request.params.provider);
      if (!provider) {
        return reply.code(404).send({ error: "지원하지 않는 provider입니다." });
      }
      const from = readOptionalNumber(request.query.from) ?? 0;
      const to = readOptionalNumber(request.query.to) ?? Number.MAX_SAFE_INTEGER;
      const seconds = await frameReader.listFrameSeconds(request.params.broadcastId, provider, Math.floor(from), Math.floor(to));
      const response: FrameIndexResponse = { seconds };
      return response;
    }
  );

  app.get<{ Params: { broadcastId: string; provider: string; second: string } }>(
    "/api/broadcasts/:broadcastId/frames/:provider/:second",
    async (request, reply) => {
      if (!isValidBroadcastId(request.params.broadcastId)) {
        return reply.code(400).send({ error: "잘못된 방송 id입니다." });
      }
      const provider = broadcastProviderFor(request.params.provider);
      if (!provider) {
        return reply.code(404).send({ error: "지원하지 않는 provider입니다." });
      }
      const second = Number(request.params.second.replace(/\.jpg$/i, ""));
      if (!Number.isFinite(second)) {
        return reply.code(400).send({ error: "잘못된 시각입니다." });
      }
      const framePath = await frameReader.nearestFramePath(request.params.broadcastId, provider, Math.floor(second));
      if (framePath === undefined) {
        return reply.code(404).send({ error: "해당 시각의 프레임이 없습니다." });
      }
      return reply
        .type("image/jpeg")
        .header("Cache-Control", "public, max-age=86400")
        .send(createReadStream(framePath));
    }
  );
}
