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
import type { ChzzkTokenSet, ProviderAdapter, ProviderCallbacks } from "./providers/types";
import { SoopUnofficialAdapter } from "./providers/soopUnofficial";
import { classifyProviderFailureReason } from "./providerDiagnostics";
import { FrameCaptureManager, fetchChzzkHlsUrl, fetchSoopHlsUrl } from "./frameCapture";
import { getFfmpegReadiness, probeFfmpeg } from "./ffmpegRuntime";
import { CAPTURE_READY_TIMEOUT_MS, planFromReadiness, type CaptureReadiness } from "../shared/captureReadiness";
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
// 콜백은 "미설치로 확정되지 않았나"를 반환한다 — unknown(프로브 전)/ready는 true, 확정 미설치만 false.
const isFfmpegNotMissing = () => getFfmpegReadiness() !== "missing";
const frameCapture = new FrameCaptureManager(
  path.resolve(process.cwd(), config.chatDataDir, "frames", "chzzk"),
  fetchChzzkHlsUrl,
  (level, message) => appendProviderLog({ provider: "chzzk", level, message }),
  isFfmpegNotMissing
);
const frameCaptureSoop = new FrameCaptureManager(
  path.resolve(process.cwd(), config.chatDataDir, "frames", "soop"),
  fetchSoopHlsUrl,
  (level, message) => appendProviderLog({ provider: "soop", level, message }),
  isFfmpegNotMissing
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
// provider별 연결 세대 카운터 — 연타 재연결 시 "내 시퀀스가 최신인가"를 원리적으로 구분하는 취소 토큰.
// 공유 stopped 플래그만으로는 새 시퀀스의 start()가 stopped를 되돌려 구 시퀀스의 폴 루프가
// 취소 창을 놓치므로, 캡처 대기 취소·스테일 어댑터 정리를 이 카운터로 판정한다.
const connectSeq: Record<ChatProvider, number> = { chzzk: 0, soop: 0 };
// 캡처 선기동 동기화 킬스위치 — CAPTURE_SYNC=0이면 구 fire-and-forget 동작(채팅 먼저, 캡처 백그라운드)으로 폴백.
const captureSyncEnabled = process.env.CAPTURE_SYNC !== "0";
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

// 부팅 워밍업 — ffmpeg 준비 상태를 1회 프로브해 캐시한다 (연결 시 매번 spawn하지 않도록).
const ffmpegReadiness = await probeFfmpeg();
app.log.info(`ffmpeg 준비 상태: ${ffmpegReadiness} (캡처 동기화 ${captureSyncEnabled ? "on" : "off"})`);

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

/** onStatus/onMessage/onViewerCount 콜백 — 어댑터가 상태·메시지·시청자 수를 앱 상태로 흘려보낸다 */
function createProviderCallbacks(): ProviderCallbacks {
  return {
    onMessage: (message) => state.addMessage(message),
    onStatus: (status) => {
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
    onViewerCount: (provider, count) => {
      liveAnalytics.addViewerSample(provider, count);
      void recorder.recordViewerSample(provider, count).catch(() => undefined);
      analyticsDirty = true;
    }
  };
}

/** 채팅 어댑터 생성 (soop official은 호출 전에 이미 걸러진다) */
function buildAdapter(request: ConnectProviderRequest, callbacks: ProviderCallbacks): ProviderAdapter | undefined {
  if (request.provider === "chzzk") {
    return request.sourceMode === "unofficial"
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
  }
  if (request.provider === "soop") {
    return new SoopUnofficialAdapter(request.channelId ?? config.soopDefaultChannelId ?? "", callbacks);
  }
  return undefined;
}

/** 캡처 선기동에 쓸 채널 id — adapter.connect 이전 시점이라 request.channelId ?? provider별 default를 쓴다 */
function resolveFrameChannelId(request: ConnectProviderRequest): string {
  if (request.provider === "chzzk") {
    return request.channelId ?? config.defaultChannelId ?? "";
  }
  return request.channelId ?? config.soopDefaultChannelId ?? "";
}

/**
 * 캡처를 채팅보다 먼저 기동하고 준비 상태를 최대 N초 대기한다.
 * 비활성/미적용(킬스위치·FRAME_CAPTURE=0·채널 공백)이면 대기 없이 "disabled".
 * 대기 중엔 connecting("이미지 준비 중...")을 노출하고, 취소 토큰(세대 카운터)으로 연타 재연결을 즉시 이탈한다 [B1].
 */
async function primeCaptureAndWait(request: ConnectProviderRequest, mySeq: number): Promise<CaptureReadiness> {
  const provider = request.provider;
  const manager = frameCaptureManagers[provider];
  const frameChannelId = resolveFrameChannelId(request);
  if (!captureSyncEnabled || !manager.isEnabled() || !frameChannelId) {
    return "disabled";
  }
  await manager.start(frameChannelId).catch(() => undefined);
  state.setStatus({
    provider,
    sourceMode: request.sourceMode,
    state: "connecting",
    channelId: frameChannelId,
    message: "이미지 준비 중..."
  });
  return manager.waitUntilReady(CAPTURE_READY_TIMEOUT_MS, () => mySeq !== connectSeq[provider]);
}

/** 캡처 준비 판정에 경고가 있으면 진단 로그 + 연결 상태 메시지에 반영한다 (채팅은 그대로 붙은 상태) */
function applyCaptureWarning(warning: string | undefined, request: ConnectProviderRequest) {
  if (!warning) {
    return;
  }
  appendProviderLog({ provider: request.provider, sourceMode: request.sourceMode, level: "warning", message: warning });
  const connected = state.getStatus(request.provider);
  state.setStatus({ ...connected, message: warning });
}

const cancelledConnectResult = () => ({
  ok: false as const,
  error: "연결이 취소되었습니다.",
  providerStatuses: state.getStatuses()
});

async function connectProvider(request: ConnectProviderRequest) {
  const provider = request.provider;
  const mySeq = ++connectSeq[provider];
  await disconnectProvider(provider, false);
  appendProviderLog({
    provider,
    sourceMode: request.sourceMode,
    level: "info",
    channelId: request.channelId,
    message: "채팅 소스 연결을 시작했습니다."
  });

  if (provider === "soop" && request.sourceMode !== "unofficial") {
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

  // 캡처 선기동 → 준비 대기 → 채팅 시작 여부 판정 (시퀀스 뒤집기의 핵심)
  const readiness = await primeCaptureAndWait(request, mySeq);
  if (mySeq !== connectSeq[provider]) {
    return cancelledConnectResult();
  }
  const plan = planFromReadiness(readiness);
  if (!plan.startChat) {
    return cancelledConnectResult();
  }

  const adapter = buildAdapter(request, createProviderCallbacks());
  if (!adapter) {
    return { ok: false, error: "지원하지 않는 provider입니다." };
  }
  currentAdapters.set(provider, adapter);

  try {
    await adapter.connect();
    // 연결 도중 새 시퀀스가 진입했으면 이 어댑터는 고아 — 정리하고 중단 (currentAdapters는 새 시퀀스 소유이므로 덮어쓰지 않는다)
    if (mySeq !== connectSeq[provider]) {
      await adapter.disconnect().catch(() => undefined);
      if (currentAdapters.get(provider) === adapter) {
        currentAdapters.delete(provider);
      }
      return cancelledConnectResult();
    }
    const resultState = adapter.getStatus().state;
    const isFailureState = ["error", "unsupported", "auth_required", "offline"].includes(resultState);
    if (isFailureState) {
      // 채팅이 안 붙었으면 선기동한 캡처는 고아 — 정리 (no-hls 백오프도 함께 멈춤)
      await frameCaptureManagers[provider].stop();
    } else {
      appendProviderLog({
        provider,
        sourceMode: request.sourceMode,
        level: "success",
        channelId: adapter.getStatus().channelId ?? request.channelId,
        message: "채팅 소스 연결이 완료되었습니다."
      });
      applyCaptureWarning(plan.warning, request);
      // 킬스위치: 동기화 off일 땐 구 동작(채팅 먼저 → 캡처 백그라운드 fire-and-forget)으로 폴백
      if (!captureSyncEnabled) {
        const fallbackDefault = provider === "chzzk" ? config.defaultChannelId : config.soopDefaultChannelId;
        const frameChannelId = adapter.getStatus().channelId ?? request.channelId ?? fallbackDefault ?? "";
        void frameCaptureManagers[provider].start(frameChannelId).catch(() => undefined);
      }
    }
    return { ok: !isFailureState, providerStatus: adapter.getStatus(), providerStatuses: state.getStatuses() };
  } catch (error) {
    app.log.error(
      { err: error, provider, sourceMode: request.sourceMode, channelId: request.channelId },
      "채팅 소스 연결 중 오류가 발생했습니다."
    );
    currentAdapters.delete(provider);
    // 연결 실패 → 선기동한 캡처 정리 (스테일이면 새 시퀀스 소유이므로 건드리지 않는다)
    if (mySeq === connectSeq[provider]) {
      await frameCaptureManagers[provider].stop();
    }
    const status = {
      provider,
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
