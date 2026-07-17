import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { registerFrameRoutes } from "../src/server/routes/frames";
import { BroadcastFrameReader } from "../src/server/broadcast/broadcastFrameReader";
import { BroadcastPaths } from "../src/server/broadcast/broadcastPaths";
import { createBroadcastId } from "../src/server/broadcast/broadcastId";
import type { FrameCaptureManager } from "../src/server/frameCapture";
import type { FrameIndexResponse } from "../src/shared/types";

describe("과거 방송 프레임 라우트 (/api/broadcasts)", () => {
  let app: FastifyInstance;
  let root: string;
  let broadcastId: string;

  beforeAll(async () => {
    root = await mkdtemp(path.join(tmpdir(), "frame-routes-"));
    broadcastId = createBroadcastId();
    const frameDir = path.join(root, broadcastId, "frame", "chzzk");
    await mkdir(frameDir, { recursive: true });
    for (const second of [100, 105, 110]) {
      await writeFile(path.join(frameDir, `${second}.jpg`), `frame:${second}`);
    }

    app = Fastify();
    // 신규 라우트는 매니저를 쓰지 않고, 라이브 라우트는 이 테스트의 대상이 아니다 — 스텁으로 충분.
    const frameManagers = {} as Record<"chzzk" | "soop", FrameCaptureManager>;
    registerFrameRoutes(app, { frameManagers, frameReader: new BroadcastFrameReader(new BroadcastPaths(root)) });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    await rm(root, { recursive: true, force: true });
  });

  it("index 200: fixture 프레임 초를 반환하고 from/to 필터가 동작한다", async () => {
    const all = await app.inject({ url: `/api/broadcasts/${broadcastId}/frames/chzzk/index` });
    expect(all.statusCode).toBe(200);
    expect(all.json() as FrameIndexResponse).toEqual({ seconds: [100, 105, 110] });

    const filtered = await app.inject({ url: `/api/broadcasts/${broadcastId}/frames/chzzk/index?from=103&to=111` });
    expect(filtered.json() as FrameIndexResponse).toEqual({ seconds: [105, 110] });
  });

  it("index 200: 폴더 없는(형식은 유효한) broadcastId → { seconds: [] }", async () => {
    const response = await app.inject({ url: `/api/broadcasts/${createBroadcastId()}/frames/chzzk/index` });
    expect(response.statusCode).toBe(200);
    expect(response.json() as FrameIndexResponse).toEqual({ seconds: [] });
  });

  it("index 400: broadcastId 형식 불량(traversal 시도)을 거부한다", async () => {
    const response = await app.inject({ url: "/api/broadcasts/..%2F..%2Fetc/frames/chzzk/index" });
    expect(response.statusCode).toBe(400);
  });

  it("index 404: 지원하지 않는 provider", async () => {
    const response = await app.inject({ url: `/api/broadcasts/${broadcastId}/frames/mixer/index` });
    expect(response.statusCode).toBe(404);
  });

  it("second 200: 이미지 바이트와 캐시 헤더를 반환한다", async () => {
    const response = await app.inject({ url: `/api/broadcasts/${broadcastId}/frames/chzzk/100.jpg` });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toBe("image/jpeg");
    expect(response.headers["cache-control"]).toBe("public, max-age=86400");
    expect(response.body).toBe("frame:100");
  });

  it("second 200: 최근접 프레임을 서빙한다 (114 요청 → 110.jpg)", async () => {
    const response = await app.inject({ url: `/api/broadcasts/${broadcastId}/frames/chzzk/114.jpg` });
    expect(response.statusCode).toBe(200);
    expect(response.body).toBe("frame:110");
  });

  it("second 400: 숫자 아님 / second 404: tolerance 밖", async () => {
    const invalid = await app.inject({ url: `/api/broadcasts/${broadcastId}/frames/chzzk/abc.jpg` });
    expect(invalid.statusCode).toBe(400);

    const outOfTolerance = await app.inject({ url: `/api/broadcasts/${broadcastId}/frames/chzzk/95.jpg` });
    expect(outOfTolerance.statusCode).toBe(404);
  });

  it("기존 라이브 라우트 경로와 경합 없음 — 등록이 예외 없이 성공했고 라이브 주소는 그대로 매칭된다", async () => {
    // duplicate route면 registerFrameRoutes가 throw해 beforeAll에서 이미 실패한다.
    // 라이브 주소가 신규 네임스페이스에 빼앗기지 않았는지만 확인한다(스텁 매니저 → 404 응답이 정상).
    const live = await app.inject({ url: "/api/frames/chzzk/status" });
    expect(live.statusCode).toBe(404);
  });
});
