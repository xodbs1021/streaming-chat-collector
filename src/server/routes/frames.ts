import type { FastifyInstance } from "fastify";
import { createReadStream } from "node:fs";
import { FrameCaptureManager } from "../frameCapture";
import { readOptionalNumber } from "./params";

interface FrameRouteDeps {
  frameManagers: Record<"chzzk" | "soop", FrameCaptureManager>;
}

export function registerFrameRoutes(app: FastifyInstance, deps: FrameRouteDeps) {
  const { frameManagers } = deps;

  function frameManagerFor(provider: string): FrameCaptureManager | undefined {
    return provider === "chzzk" || provider === "soop" ? frameManagers[provider] : undefined;
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
}
