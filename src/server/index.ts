import path from "node:path";
import { randomUUID } from "node:crypto";
import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import Fastify from "fastify";
import { Server } from "socket.io";
import { LiveAnalytics } from "./analytics";
import { config } from "./config";
import { ChzzkOfficialAdapter } from "./providers/chzzkOfficial";
import { ChzzkUnofficialAdapter } from "./providers/chzzkUnofficial";
import type { ChzzkTokenSet, ProviderAdapter } from "./providers/types";
import { SoopUnofficialAdapter } from "./providers/soopUnofficial";
import { classifyProviderFailureReason } from "./providerDiagnostics";
import { FrameCaptureManager, fetchChzzkHlsUrl, fetchSoopHlsUrl } from "./frameCapture";
import { ChatRecorder } from "./recorder";
import { AppState, type AppSocketServer } from "./state";
import { persistChzzkToken, readStoredChzzkToken } from "./chzzkTokenStore";
import { registerAnalyticsRoutes } from "./routes/analytics";
import { registerAuthRoutes } from "./routes/auth";
import { registerProviderRoutes } from "./routes/providers";
import { registerFrameRoutes } from "./routes/frames";
import type {
  ChatMessage,
  ChatProvider,
  ConnectProviderRequest,
  OverlaySettings,
  ProviderDiagnosticLog,
  ProviderStatus
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
let chzzkToken: ChzzkTokenSet | undefined = await readStoredChzzkToken(chzzkTokenPath);
const getChzzkToken = () => chzzkToken;
const setChzzkToken = async (token: ChzzkTokenSet) => {
  chzzkToken = token;
  await persistChzzkToken(chzzkTokenPath, token);
};
const LIVE_EMIT_INTERVAL_MS = 10;
const LIVE_EMIT_WINDOW_LIMIT = 24;

let analyticsDirty = false;
let recordingStatusDirty = false;

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

registerAnalyticsRoutes(app, { recorder, liveAnalytics, io });
registerProviderRoutes(app, { state, providerLogs, connectProvider, disconnectProvider });
registerAuthRoutes(app, { state, getChzzkToken, setChzzkToken });
registerFrameRoutes(app, { frameManagers: frameCaptureManagers });

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
              void persistChzzkToken(chzzkTokenPath, token);
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

type ClientToServerEvents = import("../shared/types").ClientToServerEvents;
type ServerToClientEvents = import("../shared/types").ServerToClientEvents;
