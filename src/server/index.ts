import { createReadStream } from "node:fs";
import path from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { randomBytes, randomUUID } from "node:crypto";
import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import Fastify from "fastify";
import { Server } from "socket.io";
import {
  LiveAnalytics,
  computeOverallParticipationRate,
  summarizeChatRecords,
  summarizeHighlightCandidates,
  summarizeWindowComparison
} from "./analytics";
import { CHZZK_ACCOUNT_INTERLOCK_URL, CHZZK_HOME_URL, CHZZK_OPEN_API_BASE, NAVER_LOGIN_URL, config } from "./config";
import { ChzzkOfficialAdapter } from "./providers/chzzkOfficial";
import { ChzzkUnofficialAdapter } from "./providers/chzzkUnofficial";
import { parseChzzkTokenResponse } from "./providers/chzzkToken";
import type { ChzzkTokenSet, ProviderAdapter } from "./providers/types";
import { SoopUnofficialAdapter } from "./providers/soopUnofficial";
import { classifyProviderFailureReason } from "./providerDiagnostics";
import { FrameCaptureManager, fetchChzzkHlsUrl, fetchSoopHlsUrl } from "./frameCapture";
import { ChatRecorder } from "./recorder";
import { AppState, type AppSocketServer } from "./state";
import type {
  AnalyticsRankItem,
  ChatMessage,
  ChatProvider,
  ChatRecord,
  ConnectProviderRequest,
  HighlightCategory,
  OverlaySettings,
  ProviderDiagnosticLog,
  ProviderStatus,
  ViewerCountSample,
  WindowComparisonSummary
} from "../shared/types";

const app = Fastify({ logger: true });
await app.register(cors, { origin: true });

const io = new Server<ClientToServerEvents, ServerToClientEvents>(app.server, {
  cors: { origin: true }
}) as AppSocketServer;
const recorder = new ChatRecorder(path.resolve(process.cwd(), config.chatDataDir));
const frameCapture = new FrameCaptureManager(
  path.resolve(process.cwd(), config.chatDataDir, "frames", "chzzk"),
  fetchChzzkHlsUrl,
  (level, message) => appendProviderLog({ provider: "chzzk", level, message })
);
const frameCaptureSoop = new FrameCaptureManager(
  path.resolve(process.cwd(), config.chatDataDir, "frames", "soop"),
  fetchSoopHlsUrl,
  (level, message) => appendProviderLog({ provider: "soop", level, message })
);
const frameCaptureManagers = { chzzk: frameCapture, soop: frameCaptureSoop } as const;
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void Promise.all([frameCapture.stop(), frameCaptureSoop.stop()]).finally(() => process.exit(0));
  });
}
const liveAnalytics = new LiveAnalytics();
const state = new AppState(io, {
  onMessage: (message) => {
    void handleRecordedMessage(message);
  }
});

const currentAdapters = new Map<ChatProvider, ProviderAdapter>();
const providerLogs: ProviderDiagnosticLog[] = [];
const chzzkTokenPath = path.resolve(process.cwd(), config.chatDataDir, ".chzzk-token.json");
let chzzkToken: ChzzkTokenSet | undefined = await readStoredChzzkToken();
const oauthStates = new Map<string, number>();
const OAUTH_STATE_TTL_MS = 600_000;
const LIVE_EMIT_INTERVAL_MS = 10;
const LIVE_COMPARISON_CACHE_MS = 5_000;
const LIVE_EMIT_WINDOW_LIMIT = 24;

let analyticsDirty = false;
let recordingStatusDirty = false;
let liveComparisonCache: { generatedAt: number; payload: WindowComparisonSummary } | undefined;

const liveEmitTimer = setInterval(() => {
  if (recordingStatusDirty) {
    recordingStatusDirty = false;
    io.emit("recording:status", recorder.getStatus());
  }
  if (analyticsDirty) {
    analyticsDirty = false;
    io.emit(
      "analytics:live",
      liveAnalytics.getSummary(recorder.getActiveSession(), undefined, [], { recentWindowLimit: LIVE_EMIT_WINDOW_LIMIT })
    );
  }
}, LIVE_EMIT_INTERVAL_MS);
(liveEmitTimer as { unref?: () => void }).unref?.();
const highlightCategories = new Set<HighlightCategory>(["teamfight", "player_mistake", "objective", "solo_kill", "pentakill", "macro", "other"]);

const distPath = path.resolve(process.cwd(), "dist");

await app.register(fastifyStatic, {
  root: distPath,
  prefix: "/"
});

app.get("/api/health", async () => ({
  ok: true,
  uptimeSec: Math.round(process.uptime()),
  providerStatus: state.getStatus(),
  providerStatuses: state.getStatuses()
}));

app.get("/api/settings", async () => state.getSettings());

app.put<{ Body: Partial<OverlaySettings> }>("/api/settings", async (request) => {
  return state.updateSettings(request.body ?? {});
});

app.post<{ Body: Partial<OverlaySettings> }>("/api/settings", async (request) => {
  return state.updateSettings(request.body ?? {});
});

app.get("/api/analytics/sessions", async () => recorder.listSessions());

app.get("/api/providers/logs", async () => providerLogs);

app.patch<{ Params: { sessionId: string }; Body: { displayName?: string } }>(
  "/api/analytics/sessions/:sessionId",
  async (request, reply) => {
    const session = await recorder.updateSessionMeta(request.params.sessionId, {
      displayName: String(request.body?.displayName ?? "")
    });
    if (!session) {
      return reply.code(404).send({ error: "저장된 채팅 세션을 찾지 못했습니다." });
    }
    return session;
  }
);

app.post<{ Params: { sessionId: string } }>("/api/analytics/sessions/:sessionId/archive", async (request, reply) => {
  const session = await recorder.archiveSession(request.params.sessionId);
  if (!session) {
    return reply.code(404).send({ error: "저장된 채팅 세션을 찾지 못했습니다." });
  }
  return session;
});

app.get<{ Params: { sessionId: string }; Querystring: { windowSec?: string } }>(
  "/api/analytics/sessions/:sessionId/highlights",
  async (request, reply) => {
    const session = await recorder.getSession(request.params.sessionId);
    if (!session) {
      return reply.code(404).send({ error: "저장된 채팅 세션을 찾지 못했습니다." });
    }
    const records = await recorder.readRecords(request.params.sessionId);
    const annotations = await recorder.readHighlightAnnotations(request.params.sessionId);
    return summarizeHighlightCandidates(records, readWindowSec(request.query.windowSec), session, annotations, true);
  }
);

app.get<{ Params: { sessionId: string }; Querystring: { windowSec?: string; keywords?: string } }>(
  "/api/analytics/sessions/:sessionId/windows",
  async (request, reply) => {
    const session = await recorder.getSession(request.params.sessionId);
    if (!session) {
      return reply.code(404).send({ error: "저장된 채팅 세션을 찾지 못했습니다." });
    }
    const [records, viewerSamples] = await Promise.all([
      recorder.readRecords(request.params.sessionId),
      recorder.readViewerSamples(request.params.sessionId)
    ]);
    return summarizeChatRecords(records, readWindowSec(request.query.windowSec), session, viewerSamples, readKeywords(request.query.keywords));
  }
);

app.get<{ Params: { sessionId: string }; Querystring: { format?: string } }>(
  "/api/analytics/sessions/:sessionId/export",
  async (request, reply) => {
    const session = await recorder.getSession(request.params.sessionId);
    if (!session) {
      return reply.code(404).send({ error: "저장된 채팅 세션을 찾지 못했습니다." });
    }
    const [records, viewerSamples, markers] = await Promise.all([
      recorder.readRecords(request.params.sessionId),
      recorder.readViewerSamples(request.params.sessionId),
      recorder.readMarkers(request.params.sessionId)
    ]);
    const overallParticipationRate = computeOverallParticipationRate(records, viewerSamples);
    if (request.query.format === "json") {
      return reply
        .header("Content-Disposition", `attachment; filename="${session.sessionId}.json"`)
        .type("application/json; charset=utf-8")
        .send(JSON.stringify({ session, records, viewerSamples, markers, overallParticipationRate }, null, 2));
    }
    return reply
      .header("Content-Disposition", `attachment; filename="${session.sessionId}.csv"`)
      .type("text/csv; charset=utf-8")
      .send(buildCsv(records, session.startedAt, viewerSamples, overallParticipationRate));
  }
);

app.delete<{ Params: { sessionId: string } }>("/api/analytics/sessions/:sessionId", async (request, reply) => {
  const result = await recorder.deleteSession(request.params.sessionId);
  if (result === "active") {
    return reply.code(409).send({ error: "진행 중인 세션은 삭제할 수 없습니다. 먼저 연결을 해제하세요." });
  }
  if (result === "missing") {
    return reply.code(404).send({ error: "저장된 채팅 세션을 찾지 못했습니다." });
  }
  return { deletedSessionId: request.params.sessionId };
});

app.get<{ Params: { sessionId: string } }>("/api/analytics/sessions/:sessionId/window-compare", async (request, reply) => {
  const session = await recorder.getSession(request.params.sessionId);
  if (!session) {
    return reply.code(404).send({ error: "저장된 채팅 세션을 찾지 못했습니다." });
  }
  const records = await recorder.readRecords(request.params.sessionId);
  return summarizeWindowComparison(records, undefined, session);
});

app.get<{ Params: { sessionId: string } }>("/api/analytics/sessions/:sessionId/markers", async (request, reply) => {
  const session = await recorder.getSession(request.params.sessionId);
  if (!session) {
    return reply.code(404).send({ error: "저장된 채팅 세션을 찾지 못했습니다." });
  }
  return { sessionId: session.sessionId, markers: await recorder.readMarkers(session.sessionId) };
});

app.post<{ Params: { sessionId: string }; Body: { timestamp?: number; label?: string; endAt?: number } }>(
  "/api/analytics/sessions/:sessionId/markers",
  async (request, reply) => {
    const session = await recorder.getSession(request.params.sessionId);
    if (!session) {
      return reply.code(404).send({ error: "저장된 채팅 세션을 찾지 못했습니다." });
    }
    const timestamp = readOptionalNumber(request.body?.timestamp);
    const label = String(request.body?.label ?? "").trim().slice(0, 40);
    if (timestamp === undefined || !label) {
      return reply.code(400).send({ error: "timestamp와 label이 필요합니다." });
    }
    const marker = await recorder.writeMarker(session.sessionId, {
      timestamp,
      label,
      endAt: readOptionalNumber(request.body?.endAt)
    });
    return { sessionId: session.sessionId, marker };
  }
);

app.delete<{ Params: { sessionId: string; markerId: string } }>(
  "/api/analytics/sessions/:sessionId/markers/:markerId",
  async (request, reply) => {
    const deleted = await recorder.deleteMarker(request.params.sessionId, request.params.markerId);
    if (!deleted) {
      return reply.code(404).send({ error: "삭제할 구간 마커를 찾지 못했습니다." });
    }
    return { sessionId: request.params.sessionId, deletedMarkerId: deleted.id };
  }
);

app.get("/api/analytics/live/markers", async () => {
  const activeSession = recorder.getActiveSession();
  if (!activeSession) {
    return { sessionId: undefined, canSave: false, markers: [] };
  }
  return { sessionId: activeSession.sessionId, canSave: true, markers: await recorder.readMarkers(activeSession.sessionId) };
});

app.post<{ Body: { timestamp?: number; label?: string; endAt?: number } }>("/api/analytics/live/markers", async (request, reply) => {
  const activeSession = recorder.getActiveSession();
  if (!activeSession) {
    return reply.code(400).send({ error: "진행 중인 세션이 없어 구간 마커를 저장할 수 없습니다." });
  }
  const timestamp = readOptionalNumber(request.body?.timestamp);
  const label = String(request.body?.label ?? "").trim().slice(0, 40);
  if (timestamp === undefined || !label) {
    return reply.code(400).send({ error: "timestamp와 label이 필요합니다." });
  }
  const marker = await recorder.writeMarker(activeSession.sessionId, {
    timestamp,
    label,
    endAt: readOptionalNumber(request.body?.endAt)
  });
  return { sessionId: activeSession.sessionId, marker };
});

app.get<{ Params: { sessionId: string } }>("/api/analytics/sessions/:sessionId/annotations", async (request, reply) => {
  const session = await recorder.getSession(request.params.sessionId);
  if (!session) {
    return reply.code(404).send({ error: "저장된 채팅 세션을 찾지 못했습니다." });
  }
  return {
    sessionId: session.sessionId,
    annotations: await recorder.readHighlightAnnotations(request.params.sessionId)
  };
});

app.put<{
  Params: { sessionId: string; candidateId: string };
  Body: {
    category?: HighlightCategory;
    note?: string;
    startAt?: number;
    endAt?: number;
    windowSec?: number;
    peakCount?: number;
    totalMessages?: number;
    topTerms?: AnalyticsRankItem[];
  };
}>(
  "/api/analytics/sessions/:sessionId/annotations/:candidateId",
  async (request, reply) => {
    const session = await recorder.getSession(request.params.sessionId);
    if (!session) {
      return reply.code(404).send({ error: "저장된 채팅 세션을 찾지 못했습니다." });
    }
    const category = request.body?.category ?? "other";
    if (!highlightCategories.has(category)) {
      return reply.code(400).send({ error: "지원하지 않는 하이라이트 분류입니다." });
    }
    const annotation = await recorder.writeHighlightAnnotation(request.params.sessionId, request.params.candidateId, {
      category,
      note: String(request.body?.note ?? "").slice(0, 500),
      startAt: readOptionalNumber(request.body?.startAt),
      endAt: readOptionalNumber(request.body?.endAt),
      windowSec: readOptionalNumber(request.body?.windowSec),
      peakCount: readOptionalNumber(request.body?.peakCount),
      totalMessages: readOptionalNumber(request.body?.totalMessages),
      topTerms: readRankItems(request.body?.topTerms)
    });
    return { sessionId: session.sessionId, annotation };
  }
);

app.delete<{ Params: { sessionId: string; candidateId: string } }>(
  "/api/analytics/sessions/:sessionId/annotations/:candidateId",
  async (request, reply) => {
    const session = await recorder.getSession(request.params.sessionId);
    if (!session) {
      return reply.code(404).send({ error: "저장된 채팅 세션을 찾지 못했습니다." });
    }
    const deleted = await recorder.deleteHighlightAnnotation(request.params.sessionId, request.params.candidateId);
    if (!deleted) {
      return reply.code(404).send({ error: "삭제할 하이라이트 메모를 찾지 못했습니다." });
    }
    return { sessionId: session.sessionId, deletedCandidateId: deleted.candidateId };
  }
);

app.get<{ Params: { sessionId: string } }>("/api/analytics/sessions/:sessionId", async (request, reply) => {
  const session = await recorder.getSession(request.params.sessionId);
  if (!session) {
    return reply.code(404).send({ error: "저장된 채팅 세션을 찾지 못했습니다." });
  }
  const records = await recorder.readRecords(request.params.sessionId);
  return { session, records };
});

app.get<{ Querystring: { windowSec?: string } }>("/api/analytics/live/highlights", async (request) => {
  const activeSession = recorder.getActiveSession();
  const annotations = activeSession ? await recorder.readHighlightAnnotations(activeSession.sessionId) : {};
  return summarizeHighlightCandidates(
    liveAnalytics.getRecords(),
    readWindowSec(request.query.windowSec),
    activeSession,
    annotations,
    Boolean(activeSession)
  );
});

app.get("/api/analytics/live/window-compare", async () => {
  if (liveComparisonCache && Date.now() - liveComparisonCache.generatedAt < LIVE_COMPARISON_CACHE_MS) {
    return liveComparisonCache.payload;
  }
  const payload = summarizeWindowComparison(liveAnalytics.getRecords(), undefined, recorder.getActiveSession());
  liveComparisonCache = { generatedAt: Date.now(), payload };
  return payload;
});

app.get<{ Querystring: { windowSec?: string; keywords?: string } }>("/api/analytics/live", async (request) =>
  liveAnalytics.getSummary(recorder.getActiveSession(), readWindowSec(request.query.windowSec), readKeywords(request.query.keywords))
);

app.post<{ Querystring: { windowSec?: string } }>("/api/analytics/live/reset", async (request) => {
  liveAnalytics.reset();
  liveComparisonCache = undefined;
  const summary = liveAnalytics.getSummary(recorder.getActiveSession(), readWindowSec(request.query.windowSec));
  io.emit("analytics:live", summary);
  return summary;
});

app.get("/api/auth/chzzk/login", async (_request, reply) => {
  const naverLoginUrl = new URL(NAVER_LOGIN_URL);
  naverLoginUrl.searchParams.set("mode", "form");
  naverLoginUrl.searchParams.set("url", CHZZK_HOME_URL);

  return reply.redirect(naverLoginUrl.toString());
});

app.get<{ Querystring: { viaNaver?: string } }>("/api/auth/chzzk/start", async (request, reply) => {
  if (!config.chzzkClientId) {
    return reply.code(400).send({
      error: "CHZZK_CLIENT_ID가 .env에 없습니다.",
      hint: ".env.example을 복사해 치지직 Developers 앱 정보를 입력하세요."
    });
  }

  const oauthState = randomBytes(18).toString("base64url");
  pruneOauthStates();
  oauthStates.set(oauthState, Date.now());

  const url = new URL(CHZZK_ACCOUNT_INTERLOCK_URL);
  url.searchParams.set("clientId", config.chzzkClientId);
  url.searchParams.set("redirectUri", config.chzzkRedirectUri);
  url.searchParams.set("state", oauthState);

  if (request.query.viaNaver === "1") {
    const naverLoginUrl = new URL(NAVER_LOGIN_URL);
    naverLoginUrl.searchParams.set("mode", "form");
    naverLoginUrl.searchParams.set("url", url.toString());
    return reply.redirect(naverLoginUrl.toString());
  }

  return reply.redirect(url.toString());
});

app.get<{ Querystring: { code?: string; state?: string; error?: string; error_description?: string } }>("/api/auth/chzzk/callback", async (request, reply) => {
  const { code, state: returnedState, error, error_description } = request.query;
  if (error) {
    const message = error_description || error;
    state.setStatus({
      provider: "chzzk",
      sourceMode: "official",
      state: "error",
      message: `치지직 공식 로그인이 취소되었거나 실패했습니다: ${message}`
    });
    return redirectAdmin(reply, "error", message);
  }

  if (!code || !returnedState || !takeOauthState(returnedState)) {
    const message = "치지직 OAuth callback state가 올바르지 않습니다. 로그인 버튼을 다시 눌러주세요.";
    state.setStatus({
      provider: "chzzk",
      sourceMode: "official",
      state: "error",
      message
    });
    return redirectAdmin(reply, "error", message);
  }

  try {
    chzzkToken = await exchangeAuthorizationCode(code, returnedState);
    await persistChzzkToken(chzzkToken);
    state.setStatus({
      provider: "chzzk",
      sourceMode: "official",
      state: "idle",
      message: "치지직 공식 로그인이 완료되었습니다. 관리 화면에서 연결을 누르세요."
    });
    return redirectAdmin(reply, "ok");
  } catch (error) {
    const message = error instanceof Error ? error.message : "치지직 토큰 발급 실패";
    app.log.error(error);
    state.setStatus({
      provider: "chzzk",
      sourceMode: "official",
      state: "error",
      message
    });
    return redirectAdmin(reply, "error", message);
  }
});

app.get("/api/auth/chzzk/status", async () => ({
  configured: Boolean(config.chzzkClientId && config.chzzkClientSecret),
  hasToken: Boolean(chzzkToken),
  redirectUri: config.chzzkRedirectUri,
  frontendOrigin: config.frontendOrigin,
  chzzkHomeUrl: CHZZK_HOME_URL
}));

app.post<{ Body: ConnectProviderRequest }>("/api/providers/chzzk/connect", async (request, reply) => {
  const result = await connectProvider(request.body ?? { provider: "chzzk", sourceMode: "official" });
  return reply.code(result.ok ? 200 : 400).send(result);
});

app.post("/api/providers/chzzk/disconnect", async () => {
  await disconnectProvider("chzzk", true, { provider: "chzzk", sourceMode: "official" });
  return { ok: true, providerStatus: state.getStatus("chzzk"), providerStatuses: state.getStatuses() };
});

app.post<{ Body: ConnectProviderRequest }>("/api/providers/soop/connect", async (request, reply) => {
  const result = await connectProvider(request.body ?? { provider: "soop", sourceMode: "unofficial" });
  return reply.code(result.ok ? 200 : 400).send(result);
});

app.post("/api/providers/soop/disconnect", async () => {
  await disconnectProvider("soop", true, { provider: "soop", sourceMode: "unofficial" });
  return { ok: true, providerStatus: state.getStatus("soop"), providerStatuses: state.getStatuses() };
});

function frameManagerFor(provider: string): FrameCaptureManager | undefined {
  return provider === "chzzk" || provider === "soop" ? frameCaptureManagers[provider] : undefined;
}

app.get<{ Params: { provider: string } }>("/api/frames/:provider/status", async (request, reply) => {
  const manager = frameManagerFor(request.params.provider);
  if (!manager) {
    return reply.code(404).send({ error: "지원하지 않는 provider입니다." });
  }
  return manager.getDebugState();
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

// SPA 폴백 — 정적 파일과 겹치지 않는 경로(관리 화면 등 클라이언트 라우트)만 여기로 들어온다.
// 매번 서버 재시작 없이 최신 빌드 파일을 반영하려면 정적 플러그인이 자체 와일드카드로
// 요청마다 디스크를 직접 확인해야 하므로, 수동 "/*" 라우트 대신 notFoundHandler를 쓴다.
app.setNotFoundHandler(async (_request, reply) => reply.sendFile("index.html"));

io.on("connection", (socket) => {
  state.hydrateSocket(socket.id);
  socket.emit("recording:status", recorder.getStatus());
  socket.emit("analytics:live", liveAnalytics.getSummary(recorder.getActiveSession()));

  socket.on("settings:update", (patch) => {
    state.updateSettings(patch);
  });

  socket.on("test:message", (content) => {
    state.addTestMessage(content);
  });

  socket.on("provider:connect", (request) => {
    void connectProvider(request).catch((error) => {
      state.setStatus({
        provider: request.provider,
        sourceMode: request.sourceMode,
        state: "error",
        message: error instanceof Error ? error.message : "연결 실패"
      });
    });
  });

  socket.on("provider:disconnect", (request) => {
    void disconnectProvider(request?.provider ?? state.getStatus().provider);
  });
});

await app.listen({ host: config.host, port: config.port });

async function handleRecordedMessage(message: ChatMessage) {
  try {
    const record = await recorder.recordMessage(message);
    if (!record) {
      return;
    }

    liveAnalytics.append(record);
    analyticsDirty = true;
    recordingStatusDirty = true;
  } catch (error) {
    app.log.error(error, "채팅 저장 중 오류가 발생했습니다.");
    io.emit("recording:status", {
      ...recorder.getStatus(),
      message: error instanceof Error ? error.message : "채팅 저장 중 오류가 발생했습니다."
    });
  }
}

async function connectProvider(request: ConnectProviderRequest) {
  await disconnectProvider(request.provider, false);
  appendProviderLog({
    provider: request.provider,
    sourceMode: request.sourceMode,
    level: "info",
    channelId: request.channelId,
    message: "채팅 소스 연결을 시작했습니다."
  });

  const callbacks = {
    onMessage: (message: Parameters<typeof state.addMessage>[0]) => state.addMessage(message),
    onStatus: (status: Parameters<typeof state.setStatus>[0]) => {
      // 연결된 상태에서 offline으로 바뀌면 방송이 끝난 것 — 접속 시점의 "채널을 못 찾음" offline과
      // 구분하기 위해 "이전에 connected/reconnecting이었는가"를 기준으로 삼는다.
      const previousState = state.getStatus(status.provider).state;
      const wasActive = previousState === "connected" || previousState === "reconnecting";
      state.setStatus(status);
      appendStatusLog(status);
      if (status.state === "offline" && wasActive) {
        appendProviderLog({
          provider: status.provider,
          sourceMode: status.sourceMode,
          level: "info",
          channelId: status.channelId,
          message: "방송 종료가 감지되어 연결을 자동으로 해제합니다."
        });
        void disconnectProvider(status.provider);
      }
    },
    onViewerCount: (provider: ChatProvider, count: number) => {
      liveAnalytics.addViewerSample(provider, count);
      void recorder.recordViewerSample(provider, count).catch(() => undefined);
      analyticsDirty = true;
    }
  };

  let adapter: ProviderAdapter | undefined;

  if (request.provider === "chzzk") {
    adapter =
      request.sourceMode === "unofficial"
        ? new ChzzkUnofficialAdapter(request.channelId ?? config.defaultChannelId ?? "", callbacks)
        : new ChzzkOfficialAdapter(
            config,
            () => chzzkToken,
            (token) => {
              chzzkToken = token;
              void persistChzzkToken(token);
            },
            callbacks
          );
  } else if (request.provider === "soop") {
    if (request.sourceMode !== "unofficial") {
      const status = {
        provider: "soop" as const,
        sourceMode: request.sourceMode,
        state: "unsupported" as const,
        channelId: request.channelId,
        message: "SOOP은 현재 공개 채팅 수신 모드만 지원합니다."
      };
      state.setStatus(status);
      appendStatusLog(status);
      return { ok: false, error: status.message, providerStatus: status, providerStatuses: state.getStatuses() };
    }

    adapter = new SoopUnofficialAdapter(request.channelId ?? config.soopDefaultChannelId ?? "", callbacks);
  }

  if (!adapter) {
    return { ok: false, error: "지원하지 않는 provider입니다." };
  }

  currentAdapters.set(request.provider, adapter);

  try {
    await adapter.connect();
    const resultState = adapter.getStatus().state;
    const isFailureState = ["error", "unsupported", "auth_required", "offline"].includes(resultState);
    if (!isFailureState) {
      appendProviderLog({
        provider: request.provider,
        sourceMode: request.sourceMode,
        level: "success",
        channelId: adapter.getStatus().channelId ?? request.channelId,
        message: "채팅 소스 연결이 완료되었습니다."
      });
      if (request.provider === "chzzk") {
        const frameChannelId = adapter.getStatus().channelId ?? request.channelId ?? config.defaultChannelId ?? "";
        void frameCapture.start(frameChannelId).catch(() => undefined);
      } else if (request.provider === "soop") {
        const frameChannelId = adapter.getStatus().channelId ?? request.channelId ?? config.soopDefaultChannelId ?? "";
        void frameCaptureSoop.start(frameChannelId).catch(() => undefined);
      }
    }
    return { ok: !isFailureState, providerStatus: adapter.getStatus(), providerStatuses: state.getStatuses() };
  } catch (error) {
    app.log.error(
      {
        err: error,
        provider: request.provider,
        sourceMode: request.sourceMode,
        channelId: request.channelId
      },
      "채팅 소스 연결 중 오류가 발생했습니다."
    );
    currentAdapters.delete(request.provider);
    const status = {
      provider: request.provider,
      sourceMode: request.sourceMode,
      state: "error" as const,
      channelId: request.channelId,
      message: error instanceof Error ? error.message : "채팅 소스 연결 실패"
    };
    state.setStatus(status);
    appendStatusLog(status);
    return { ok: false, error: status.message, providerStatus: status, providerStatuses: state.getStatuses() };
  }
}

async function disconnectProvider(
  provider = state.getStatus().provider,
  updateStatus = true,
  statusTarget?: Pick<ConnectProviderRequest, "provider" | "sourceMode">
) {
  const currentAdapter = currentAdapters.get(provider);
  if (currentAdapter) {
    await currentAdapter.disconnect();
    currentAdapters.delete(provider);
  }
  if (provider === "chzzk") {
    await frameCapture.stop();
  } else if (provider === "soop") {
    await frameCaptureSoop.stop();
  }
  const endedSession = await recorder.endSession(provider);
  if (endedSession) {
    io.emit("recording:status", recorder.getStatus());
    io.emit("analytics:live", liveAnalytics.getSummary(recorder.getActiveSession()));
  }

  if (updateStatus) {
    const previousStatus = state.getStatus(provider);
    const status = {
      provider: statusTarget?.provider ?? provider,
      sourceMode: statusTarget?.sourceMode ?? previousStatus.sourceMode,
      state: "idle",
      message: "채팅 소스 연결이 해제되었습니다."
    } as const;
    state.setStatus(status);
    appendProviderLog({
      provider: status.provider,
      sourceMode: status.sourceMode,
      level: "info",
      message: status.message
    });
  }
}

function readWindowSec(input: string | undefined) {
  const value = Number(input ?? 5);
  return Number.isFinite(value) ? value : 5;
}

function readKeywords(input: string | undefined) {
  if (!input) {
    return [];
  }
  return input
    .split(",")
    .map((keyword) => keyword.trim())
    .filter(Boolean)
    .slice(0, 8);
}

function buildCsv(
  records: ChatRecord[],
  startedAt?: number,
  viewerSamples: ViewerCountSample[] = [],
  overallParticipationRate?: number
) {
  const header = "timestamp,relative,provider,channel,nickname,role,content,viewers";
  const viewerTimeline = buildViewerTimeline(viewerSamples);
  const lines = records.map((record) => {
    const viewerTotal = viewerTotalAt(viewerTimeline, record.timestamp);
    return [
      new Date(record.timestamp).toISOString(),
      startedAt !== undefined && record.timestamp >= startedAt ? formatRelativeClock(record.timestamp - startedAt) : "",
      record.provider,
      csvEscape(record.channelId),
      csvEscape(record.nickname),
      record.role,
      csvEscape(record.content),
      viewerTotal === undefined ? "" : String(viewerTotal)
    ].join(",");
  });
  const summaryComment =
    overallParticipationRate !== undefined
      ? `# \uC804\uCCB4 \uBC29\uC1A1 \uCC38\uC5EC\uC728(\uD3C9\uADE0 \uC2DC\uCCAD\uC790 \uB300\uBE44): ${Math.round(overallParticipationRate * 1000) / 10}%`
      : undefined;
  const allLines = [summaryComment, header, ...lines].filter((line): line is string => Boolean(line));
  return `\uFEFF${allLines.join("\n")}\n`;
}

function buildViewerTimeline(samples: ViewerCountSample[]) {
  const sorted = [...samples].sort((left, right) => left.timestamp - right.timestamp);
  const latestByProvider = new Map<ViewerCountSample["provider"], number>();
  return sorted.map((sample) => {
    latestByProvider.set(sample.provider, sample.count);
    let total = 0;
    for (const count of latestByProvider.values()) {
      total += count;
    }
    return { timestamp: sample.timestamp, total };
  });
}

function viewerTotalAt(timeline: Array<{ timestamp: number; total: number }>, at: number) {
  let low = 0;
  let high = timeline.length - 1;
  let result: number | undefined;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (timeline[mid].timestamp <= at) {
      result = timeline[mid].total;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return result;
}

function csvEscape(value: string) {
  return `"${value.replace(/"/g, '""')}"`;
}

function formatRelativeClock(ms: number) {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(totalSec / 3600);
  const minutes = Math.floor((totalSec % 3600) / 60);
  const seconds = totalSec % 60;
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${hours}:${pad(minutes)}:${pad(seconds)}`;
}

function readOptionalNumber(input: unknown) {
  if (input === undefined || input === null) {
    return undefined;
  }
  const value = Number(input);
  return Number.isFinite(value) ? value : undefined;
}

function readRankItems(input: unknown): AnalyticsRankItem[] | undefined {
  if (!Array.isArray(input)) {
    return undefined;
  }
  return input
    .slice(0, 8)
    .map((item): AnalyticsRankItem | undefined => {
      if (!item || typeof item !== "object") {
        return undefined;
      }
      const record = item as Partial<AnalyticsRankItem>;
      const label = String(record.label ?? "").slice(0, 80);
      const count = Number(record.count ?? 0);
      if (!label || !Number.isFinite(count)) {
        return undefined;
      }
      const normalized: AnalyticsRankItem = { label, count };
      if (record.id) {
        normalized.id = String(record.id).slice(0, 80);
      }
      return normalized;
    })
    .filter((item): item is AnalyticsRankItem => Boolean(item));
}

const lastStatusLogKeys = new Map<ChatProvider, string>();

function appendStatusLog(status: ProviderStatus) {
  if (!["connected", "reconnecting", "offline", "unsupported", "auth_required", "error"].includes(status.state)) {
    return;
  }
  // 동일 상태 반복(lastEventAt 갱신 등)은 스킵 — 실제 상태 전환만 기록
  const logKey = `${status.sourceMode}|${status.state}|${status.message}`;
  if (lastStatusLogKeys.get(status.provider) === logKey) {
    return;
  }
  lastStatusLogKeys.set(status.provider, logKey);
  appendProviderLog({
    provider: status.provider,
    sourceMode: status.sourceMode,
    level: status.state === "connected" ? "success" : status.state === "reconnecting" ? "warning" : "error",
    reason: status.state === "connected" ? undefined : classifyProviderFailureReason(status.message),
    channelId: status.channelId,
    message: status.message
  });
}

function appendProviderLog(input: Omit<ProviderDiagnosticLog, "id" | "createdAt">) {
  providerLogs.unshift({
    id: randomUUID(),
    createdAt: Date.now(),
    ...input
  });
  if (providerLogs.length > 100) {
    providerLogs.length = 100;
  }
}

async function readStoredChzzkToken() {
  try {
    const content = await readFile(chzzkTokenPath, "utf8");
    const parsed = JSON.parse(content) as Partial<ChzzkTokenSet>;
    if (!parsed.accessToken) {
      return undefined;
    }
    return {
      accessToken: parsed.accessToken,
      refreshToken: parsed.refreshToken,
      tokenType: parsed.tokenType ?? "Bearer",
      expiresAt: Number(parsed.expiresAt ?? 0),
      scope: parsed.scope
    };
  } catch {
    return undefined;
  }
}

async function persistChzzkToken(token: ChzzkTokenSet | undefined) {
  if (!token) {
    return;
  }
  await mkdir(path.dirname(chzzkTokenPath), { recursive: true });
  await writeFile(chzzkTokenPath, `${JSON.stringify(token, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
}

async function exchangeAuthorizationCode(code: string, oauthState: string): Promise<ChzzkTokenSet> {
  if (!config.chzzkClientId || !config.chzzkClientSecret) {
    throw new Error("CHZZK_CLIENT_ID 또는 CHZZK_CLIENT_SECRET이 없습니다.");
  }

  const response = await fetch(`${CHZZK_OPEN_API_BASE}/auth/v1/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grantType: "authorization_code",
      clientId: config.chzzkClientId,
      clientSecret: config.chzzkClientSecret,
      code,
      state: oauthState
    })
  });

  if (!response.ok) {
    throw new Error(`치지직 토큰 발급 실패 (${response.status})`);
  }

  const token = parseChzzkTokenResponse(await response.json());
  if (!token) {
    throw new Error("치지직 토큰 응답에 accessToken이 없습니다.");
  }

  return token;
}

function redirectAdmin(reply: import("fastify").FastifyReply, status: "ok" | "error", message?: string) {
  const url = new URL("/admin", config.frontendOrigin);
  url.searchParams.set("auth", "chzzk");
  url.searchParams.set("status", status);
  if (message) {
    url.searchParams.set("message", message);
  }
  return reply.redirect(url.toString());
}

function takeOauthState(value: string) {
  pruneOauthStates();
  const createdAt = oauthStates.get(value);
  if (createdAt === undefined) {
    return false;
  }
  oauthStates.delete(value);
  return true;
}

function pruneOauthStates() {
  const cutoff = Date.now() - OAUTH_STATE_TTL_MS;
  for (const [value, createdAt] of oauthStates) {
    if (createdAt < cutoff) {
      oauthStates.delete(value);
    }
  }
}

type ClientToServerEvents = import("../shared/types").ClientToServerEvents;
type ServerToClientEvents = import("../shared/types").ServerToClientEvents;
