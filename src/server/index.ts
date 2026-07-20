import path from "node:path";
import { randomUUID } from "node:crypto";
import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import Fastify from "fastify";
import { Server } from "socket.io";
import { LiveAnalytics } from "./analytics";
import { config, RECORD_GRACE_MS } from "./config";
import { ChzzkOfficialAdapter } from "./providers/chzzkOfficial";
import { ChzzkUnofficialAdapter } from "./providers/chzzkUnofficial";
import type { ChzzkTokenSet, ProviderAdapter, ProviderCallbacks } from "./providers/types";
import { SoopUnofficialAdapter } from "./providers/soopUnofficial";
import { classifyProviderFailureReason } from "./providerDiagnostics";
import { FrameCaptureManager, fetchChzzkHlsUrl, fetchSoopHlsUrl } from "./frameCapture";
import { resolveFrameChannelInput } from "./frameChannel";
import {
  captureSlotOwns,
  resolveManagersToStopOnFinalize,
  runSingleFrameCapture,
  shouldCaptureLateJoin,
  shouldStopOrphanedManager,
  type CaptureSlot,
  type SingleFrameCaptureDeps
} from "./captureSource";
import { getFfmpegReadiness, probeFfmpeg } from "./ffmpegRuntime";
import { CAPTURE_READY_TIMEOUT_MS, planFromReadiness, type CaptureReadiness } from "../shared/captureReadiness";
import { ChatRecorder } from "./recorder";
import { LiveOffsetTracker } from "./offset/liveOffsetTracker";
import { finalizeBroadcastAlignment } from "./offset/finalizeAlignment";
import { DEFAULT_ESTIMATOR_PARAMS } from "./offset/offsetEstimator";
import { BroadcastPaths } from "./broadcast/broadcastPaths";
import { BroadcastFrameReader } from "./broadcast/broadcastFrameReader";
import { RecordingGrace } from "./broadcast/recordingGrace";
import { AppState, type AppSocketServer } from "./state";
import { persistChzzkToken, readStoredChzzkToken } from "./chzzkTokenStore";
import { registerAnalyticsRoutes } from "./routes/analytics";
import { registerAuthRoutes } from "./routes/auth";
import { registerProviderRoutes } from "./routes/providers";
import { registerFrameRoutes } from "./routes/frames";
import { registerBroadcastRoutes } from "./routes/broadcasts";
import type {
  BroadcastProviderRef,
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
// 프레임 캡처 대상 폴더 조립용 — recorder와 같은 저장 루트를 공유한다(경로 규칙은 BroadcastPaths 단일 진실원).
const broadcastPaths = new BroadcastPaths(path.resolve(process.cwd(), config.chatDataDir));
// 종료된 방송의 프레임 읽기 전용 reader — 라이브 캡처 매니저와 무관하게 /api/broadcasts 라우트에 주입한다.
const frameReader = new BroadcastFrameReader(broadcastPaths);
// 콜백은 "미설치로 확정되지 않았나"를 반환한다 — unknown(프로브 전)/ready는 true, 확정 미설치만 false.
const isFfmpegNotMissing = () => getFfmpegReadiness() !== "missing";
// 화질은 설정의 단일 진실원에서 조회한다 — state는 아래에서 초기화되지만 이 화살표는
// 캡처 spawn 시점(런타임)에만 호출되므로 참조 시 항상 초기화가 끝나 있다.
const getCaptureHeight = () => state.getSettings().captureQuality;
const frameCapture = new FrameCaptureManager(
  path.resolve(process.cwd(), config.chatDataDir, "frames", "chzzk"),
  fetchChzzkHlsUrl,
  (level, message) => appendProviderLog({ provider: "chzzk", level, message }),
  isFfmpegNotMissing,
  getCaptureHeight
);
const frameCaptureSoop = new FrameCaptureManager(
  path.resolve(process.cwd(), config.chatDataDir, "frames", "soop"),
  fetchSoopHlsUrl,
  (level, message) => appendProviderLog({ provider: "soop", level, message }),
  isFfmpegNotMissing,
  getCaptureHeight
);
const frameCaptureManagers = { chzzk: frameCapture, soop: frameCaptureSoop } as const;
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void Promise.all([frameCapture.stop(), frameCaptureSoop.stop()]).finally(() => process.exit(0));
  });
}
const liveAnalytics = new LiveAnalytics();
// offset 싱크 킬스위치(CAPTURE_SYNC 선례) — OFFSET_SYNC=0이면 라이브 무보정·finalize 재작성 생략(현행 동작 복귀).
const offsetSyncEnabled = process.env.OFFSET_SYNC !== "0";
// SOOP↔치지직 라이브 offset 추적기(메모리 보정만 — 디스크 기록은 원본). finalize가 파일 정렬 담당.
// enabled → 꺼지면 배지가 "보정 꺼짐"으로 표시(영구 "계산 중" 오해 방지).
const liveOffsetTracker = new LiveOffsetTracker({ enabled: offsetSyncEnabled });
const state = new AppState(io, {
  onMessage: (message) => {
    void handleRecordedMessage(message);
  }
});

// 녹화 자동 종료 유예 — 방송 종료(모든 provider offline) 감지 후 RECORD_GRACE_MS 뒤 녹화를 자동 확정한다.
const recordingGrace = new RecordingGrace(RECORD_GRACE_MS, () => {
  void finalizeRecording("방송 종료가 감지되어 녹화를 자동 종료했습니다.");
});

const currentAdapters = new Map<ChatProvider, ProviderAdapter>();
// provider별 연결 세대 카운터 — 연타 재연결 시 "내 시퀀스가 최신인가"를 구분하는 취소 토큰.
// adapter.connect() 도중 새 시퀀스가 진입했는지(=이 어댑터가 고아인지) 판정해 스테일 어댑터를 정리한다.
const connectSeq: Record<ChatProvider, number> = { chzzk: 0, soop: 0 };
// 캡처 선기동 동기화 킬스위치 — CAPTURE_SYNC=0이면 구 fire-and-forget 동작(채팅 먼저, 캡처 백그라운드)으로 폴백.
const captureSyncEnabled = process.env.CAPTURE_SYNC !== "0";
// 단일 소스 프레임 캡처 킬스위치 — SINGLE_FRAME_CAPTURE=0이면 슬롯 시맨틱 전체 비활성(레거시 이중 캡처 복원).
const singleFrameCaptureEnabled = process.env.SINGLE_FRAME_CAPTURE !== "0";
// 프레임을 캡처 중인 단일 소스 슬롯 — { broadcastId, provider }로 방송 스코프. 기동 호출 직전 set,
// finalize에서 그 방송 소유일 때만 리셋. 레거시 모드는 세팅하지 않는다(항상 undefined).
let captureSlot: CaptureSlot | undefined;
// provider별 캡처 매니저(싱글턴)를 마지막으로 기동한 방송 id — 고아 캡처가 매니저를 stop할지 판정하는 소유권 마커.
// 기동 직전 기록. 다음 방송이 같은 매니저를 재기동하면 소유가 넘어가, 이전 방송 고아 정리가 새 캡처를 죽이지 않는다.
const captureManagerOwner: Record<ChatProvider, string | undefined> = { chzzk: undefined, soop: undefined };
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

// 60초 주기 offset 재추정 — 실시간 경로가 아니라 이 타이머만 무거운 상관 계산을 돈다(불변식: observe는 O(1)).
const offsetReestimateTimer = setInterval(() => {
  if (!offsetSyncEnabled) {
    return;
  }
  // 트래커가 채택(retime 동반) 시에만 change를 돌려준다 — 게이트(첫 신뢰|Δ>2초)는 트래커가 소유해
  // correct()의 applied 축과 retime이 갈라지지 않게 한다.
  const change = liveOffsetTracker.reestimate();
  if (change) {
    liveAnalytics.retimeProvider("soop", change.deltaMs);
    // retime은 과거 버킷을 통째로 바꾸므로, partial 병합이 스테일 버킷을 남기지 않게 전체 summary를 1회 강제 방출.
    io.emit("analytics:live", liveAnalytics.getSummary(recorder.getActiveSession()));
  }
  io.emit("offset:live", liveOffsetTracker.getStatus());
}, DEFAULT_ESTIMATOR_PARAMS.reestimateSec * 1000);
(offsetReestimateTimer as { unref?: () => void }).unref?.();

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

/**
 * 설정 패치를 저장하고, 캡처 화질이 바뀌었으면 실행 중인 캡처를 즉시 새 화질로 재기동한다.
 * socket/PUT/POST 세 경로가 공유하는 단일 진입점 — 화질 반영 로직이 한 곳에만 있게 한다.
 */
function applySettingsPatch(patch: Partial<OverlaySettings>): OverlaySettings {
  const previousQuality = state.getSettings().captureQuality;
  const next = state.updateSettings(patch);
  if (next.captureQuality !== previousQuality) {
    for (const manager of Object.values(frameCaptureManagers)) {
      manager.restartForConfigChange();
    }
  }
  return next;
}

app.put<{ Body: Partial<OverlaySettings> }>("/api/settings", async (request) => {
  return applySettingsPatch(request.body ?? {});
});

app.post<{ Body: Partial<OverlaySettings> }>("/api/settings", async (request) => {
  return applySettingsPatch(request.body ?? {});
});

registerAnalyticsRoutes(app, {
  recorder,
  liveAnalytics,
  io,
  onLiveReset: () => {
    liveOffsetTracker.reset();
    // 배지 스테일 해소 — 리셋 즉시 새 상태(estimating)를 방출한다.
    io.emit("offset:live", liveOffsetTracker.getStatus());
  }
});
registerProviderRoutes(app, { state, providerLogs, connectProvider, disconnectProvider });
registerAuthRoutes(app, { state, getChzzkToken, setChzzkToken });
registerFrameRoutes(app, { frameManagers: frameCaptureManagers, frameReader });
registerBroadcastRoutes(app, { recorder, paths: broadcastPaths });

// SPA 폴백 — 정적 파일과 겹치지 않는 경로(관리 화면 등 클라이언트 라우트)만 여기로 들어온다.
// 매번 서버 재시작 없이 최신 빌드 파일을 반영하려면 정적 플러그인이 자체 와일드카드로
// 요청마다 디스크를 직접 확인해야 하므로, 수동 "/*" 라우트 대신 notFoundHandler를 쓴다.
app.setNotFoundHandler(async (_request, reply) => reply.sendFile("index.html"));

io.on("connection", (socket) => {
  state.hydrateSocket(socket.id);
  socket.emit("recording:status", recorder.getStatus());
  socket.emit("analytics:live", liveAnalytics.getSummary(recorder.getActiveSession()));
  socket.emit("offset:live", liveOffsetTracker.getStatus());

  socket.on("settings:update", (patch) => {
    applySettingsPatch(patch);
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

  socket.on("recording:start", () => {
    void startRecording();
  });

  socket.on("recording:stop", () => {
    void stopRecording();
  });
});

// 부팅 워밍업 — ffmpeg 준비 상태를 1회 프로브해 캐시한다 (연결 시 매번 spawn하지 않도록).
const ffmpegReadiness = await probeFfmpeg();
app.log.info(`ffmpeg 준비 상태: ${ffmpegReadiness} (캡처 동기화 ${captureSyncEnabled ? "on" : "off"})`);

await app.listen({ host: config.host, port: config.port });

async function handleRecordedMessage(message: ChatMessage) {
  try {
    // 녹화 여부와 무관하게 non-mock 메시지는 record를 돌려받아 라이브 분석에 먹인다
    // (연결=대시보드 표시가 녹화와 분리되었으므로). 디스크 저장은 recordMessage 내부에서 녹화 중일 때만.
    const record = await recorder.recordMessage(message);
    if (!record) {
      return;
    }

    // 라이브 표시만 보정한다 — 디스크 기록(recordMessage)은 이미 원본 그대로 저장됐다.
    // observe는 원본 시각으로(재추정 입력), append는 SOOP만 anchor 축으로 옮긴 표시용 시각으로.
    if (offsetSyncEnabled) {
      liveOffsetTracker.observe(record.provider, record.timestamp);
      const displayTimestamp = liveOffsetTracker.correct(record.provider, record.timestamp);
      liveAnalytics.append(displayTimestamp === record.timestamp ? record : { ...record, timestamp: displayTimestamp });
    } else {
      liveAnalytics.append(record);
    }
    analyticsDirty = true;
    if (recorder.isRecording()) {
      recordingStatusDirty = true;
    }
  } catch (error) {
    app.log.error(error, "채팅 저장 중 오류가 발생했습니다.");
    io.emit("recording:status", {
      ...recorder.getStatus(),
      message: error instanceof Error ? error.message : "채팅 저장 중 오류가 발생했습니다."
    });
  }
}

// ── 녹화 라이프사이클 오케스트레이션 ──────────────────────────────────

/** 연결된(=어댑터가 붙은) provider들을 하나의 방송으로 묶어 녹화를 시작한다. */
async function startRecording() {
  const providers = connectedProviderRefs();
  if (providers.length === 0) {
    appendProviderLog({
      provider: state.getStatus().provider,
      level: "warning",
      message: "연결된 소스가 없어 녹화를 시작하지 못했습니다."
    });
    return;
  }
  recordingGrace.cancel();
  // offset은 방송 단위 스코프 — 새 방송은 웜업부터 다시 시작한다(옛 방송의 축을 이어쓰지 않음).
  if (offsetSyncEnabled) {
    liveOffsetTracker.reset();
  }
  const broadcast = await recorder.startRecording(providers);
  if (broadcast) {
    appendProviderLog({
      provider: providers[0].provider,
      level: "success",
      message: `녹화를 시작했습니다 (${broadcast.broadcastId}).`
    });
    // 녹화 상태를 먼저 즉시 방출한다 — 캡처 준비 대기(최대 15초) 뒤로 밀지 않는다 [R1].
    emitRecordingStatus();
    // 프레임 캡처를 방송 폴더로 기동한다. fire-and-forget — 캡처 준비는 녹화·채팅을
    // 기능적으로 게이팅하지 않고(이미 시작됨) 준비 상태 메시지 UX만 구동한다 [R1].
    if (singleFrameCaptureEnabled) {
      // 단일 소스: 치지직 우선 기동, 스트림 불가 시 SOOP 대체. 슬롯은 오케스트레이터가 기동 직전 set한다.
      void runSingleFrameCapture(providers, singleFrameCaptureDeps(broadcast.broadcastId)).catch((error) =>
        app.log.error(error, "단일 소스 캡처 기동 중 오류가 발생했습니다.")
      );
    } else {
      // 킬스위치 off: 슬롯 미세팅 + 레거시 이중 캡처(참여 provider 전부 동시 기동).
      void Promise.all(providers.map((ref) => ensureCaptureForRecording(ref, broadcast.broadcastId))).catch((error) =>
        app.log.error(error, "레거시 이중 캡처 기동 중 오류가 발생했습니다.")
      );
    }
  }
}

/**
 * runSingleFrameCapture에 넘길 런타임 부작용 계약 — 이 방송(broadcastId)을 스코프로 고정한다.
 * 슬롯 minting·소유권 재확인이 모두 이 broadcastId 기준이라, 대기 중 다음 방송이 시작돼도 서로 침범하지 않는다.
 */
function singleFrameCaptureDeps(broadcastId: string): SingleFrameCaptureDeps {
  return {
    broadcastId,
    setSlot: (slot) => {
      captureSlot = slot;
    },
    ensureCapture: (ref) => ensureCaptureForRecording(ref, broadcastId),
    // 폴백은 raw start 대신 ensureCaptureForRecording를 재사용한다 — stop은 직접(멱등).
    stopChzzkCapture: () => frameCaptureManagers.chzzk.stop(),
    soopRefIfConnected: () => connectedProviderRefs().find((ref) => ref.provider === "soop"),
    isActiveBroadcast: () => recorder.getActiveBroadcastId() === broadcastId
  };
}

/** 수동 녹화 종료 — 유예 타이머를 취소하고 즉시 확정한다. */
async function stopRecording() {
  recordingGrace.cancel();
  await finalizeRecording("녹화를 종료했습니다.");
}

/** 실제 녹화 종료 처리(수동·자동 공용) — recorder.stopRecording 후 상태를 emit한다. */
async function finalizeRecording(message: string) {
  const ended = await recorder.stopRecording();
  if (ended) {
    // 녹화 종료 = 캡처 종료 (연결과 무관, start↔stop 대칭) [Q2=A]. 단, 무조건 stop하면 안 된다 —
    // recorder.stopRecording()이 큐 드레인 await 전에 활성 방송을 비우므로, 그 창에서 다음 방송이 같은
    // 매니저를 선점(재기동)했을 수 있다. 종료된 방송이 아직 소유한 매니저만 stop하고 소유권을 해제한다.
    await Promise.all(
      resolveManagersToStopOnFinalize(captureManagerOwner, ended.broadcastId).map(async (provider) => {
        await frameCaptureManagers[provider].stop();
        captureManagerOwner[provider] = undefined;
      })
    );
    // 캡처 슬롯 리셋 — 이 방송이 소유한 슬롯일 때만. stop await 사이 다음 방송이 세팅한 슬롯을
    // 지워 late-join 이중 캡처를 열지 않게 한다(방송 스코프 소유권 검사).
    if (captureSlotOwns(captureSlot, ended.broadcastId)) {
      captureSlot = undefined;
    }
    // 방송 전체 채팅으로 SOOP 파일을 anchor 축으로 일괄 정렬하고 offset.json 마커를 남긴다(킬스위치 off면 생략).
    if (offsetSyncEnabled) {
      await finalizeBroadcastAlignment(ended.broadcastId, { paths: broadcastPaths }).catch((error) =>
        app.log.error(error, "방송 종료 후 offset 정렬에 실패했습니다.")
      );
    }
    appendProviderLog({ provider: ended.providers[0]?.provider ?? "chzzk", level: "info", message });
    emitRecordingStatus();
  }
}

function emitRecordingStatus() {
  io.emit("recording:status", recorder.getStatus());
  io.emit("analytics:live", liveAnalytics.getSummary(recorder.getActiveSession()));
}

/** 현재 어댑터가 붙어 있는(connected/reconnecting) provider들을 방송 참여자로 모은다. */
function connectedProviderRefs(): BroadcastProviderRef[] {
  const refs: BroadcastProviderRef[] = [];
  for (const provider of ["chzzk", "soop"] as const) {
    const status = state.getStatus(provider);
    if (status.state === "connected" || status.state === "reconnecting") {
      refs.push({ provider, sourceMode: status.sourceMode, channelId: status.channelId ?? "" });
    }
  }
  return refs;
}

/** 녹화 중 모든 provider가 offline이면(=방송 종료) 자동종료 유예 타이머를 건다. */
function scheduleAutoStopIfBroadcastEnded() {
  if (!recorder.isRecording()) {
    return;
  }
  const anyLive = (["chzzk", "soop"] as const).some((provider) => {
    const providerState = state.getStatus(provider).state;
    return providerState === "connected" || providerState === "reconnecting";
  });
  if (!anyLive) {
    recordingGrace.schedule();
    recorder.setAutoStopPending(true);
    emitRecordingStatus();
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
      // provider가 (다시) 붙으면 녹화 자동종료 유예를 취소한다 — 같은 방송으로 이어간다.
      if ((status.state === "connected" || status.state === "reconnecting") && recordingGrace.isPending()) {
        recordingGrace.cancel();
        recorder.setAutoStopPending(false);
        emitRecordingStatus();
      }
      if (status.state === "offline" && wasActive) {
        appendProviderLog({
          provider: status.provider,
          sourceMode: status.sourceMode,
          level: "info",
          channelId: status.channelId,
          message: "방송 종료가 감지되어 연결을 자동으로 해제합니다."
        });
        void disconnectProvider(status.provider);
        // 연결은 즉시 해제하되, 녹화는 모든 provider가 offline일 때만 유예 뒤 자동 종료한다.
        scheduleAutoStopIfBroadcastEnded();
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

/**
 * 캡처용 채널 id 해석 — 입력 채널이 비면 provider별 기본 채널(env)로 폴백한다.
 * `??`가 아니라 `||`를 쓰는 게 핵심: connectedProviderRefs()가 만든 빈 문자열("")도 falsy로 보고
 * 기본 채널로 폴백해야 chzzk official(초기 status에 channelId 없음)에서 record-start 캡처가 뜬다.
 */
function frameChannelIdFor(provider: ChatProvider, rawChannelId: string): string {
  const raw = rawChannelId || (provider === "chzzk" ? config.defaultChannelId : config.soopDefaultChannelId) || "";
  // 입력창에는 라이브 URL도 들어온다 — 어댑터와 같은 파서로 정규화하지 않으면 HLS 조회가 URL로 나가 실패한다.
  return resolveFrameChannelInput(provider, raw) ?? "";
}

/**
 * 녹화 중 한 provider의 프레임 캡처를 방송 폴더로 기동하고 준비 상태를 최대 N초 대기한다.
 * record-start와 late-join(녹화 중 뒤늦게 붙는 provider) 공용. 캡처는 녹화·채팅을 게이팅하지 않으며,
 * 준비 대기는 오직 "이미지 준비 중..." → 경고/복원 상태 메시지 UX만 구동한다 [Q1=B].
 * 반환: 기동 판정(CaptureReadiness). 스킵(broadcast 없음·비활성·이미 캡처 중·CAPTURE_SYNC off)은 undefined,
 * 대기 중 녹화 종료는 "cancelled" — 단일 소스 폴백 판정(shouldFallbackToSoop)의 입력이 된다.
 */
async function ensureCaptureForRecording(
  ref: BroadcastProviderRef,
  broadcastId: string | undefined
): Promise<CaptureReadiness | undefined> {
  if (!broadcastId) {
    return undefined;
  }
  const provider = ref.provider;
  const manager = frameCaptureManagers[provider];
  const frameChannelId = frameChannelIdFor(provider, ref.channelId);
  // 비활성(FRAME_CAPTURE=0)·채널 공백이면 캡처 없음.
  if (!manager.isEnabled() || !frameChannelId) {
    return undefined;
  }
  // 이미 캡처 중인 매니저는 재기동하지 않는다 — start()가 인덱스/assigner를 리셋해 진행 중 방송을 깨기 때문.
  // (방송 내 재접속은 매니저가 stopped=false로 유지되며 기존 백오프가 자동재개한다.)
  if (!manager.getDebugState().stopped) {
    return undefined;
  }
  const framesDir = broadcastPaths.frameDir(broadcastId, provider);
  // 이 매니저의 소유를 이 방송으로 선점한다(기동 직전, 동기) — 고아 정리 시 "내가 아직 소유 중일 때만 stop"의 기준.
  // 다음 방송이 같은 매니저를 재기동하면 여기서 소유가 넘어가, 이전 방송 고아 정리가 새 캡처를 죽이지 않는다.
  captureManagerOwner[provider] = broadcastId;
  // 킬스위치 off: 준비 대기·상태 UX 없이 백그라운드로만 기동(구 fire-and-forget 동작).
  if (!captureSyncEnabled) {
    void manager.start(frameChannelId, framesDir).catch(() => undefined);
    return undefined;
  }
  await manager.start(frameChannelId, framesDir).catch(() => undefined);
  // 연결 표시는 유지한 채 message만 "이미지 준비 중..."으로 — provider는 이미 connected다(강등 금지) [R2].
  const prev = state.getStatus(provider);
  state.setStatus({ ...prev, message: "이미지 준비 중..." });
  // 대기 중 이 방송이 끝나면(수동 stop·자동종료·다음 방송 시작) 취소한다 — isRecording()이 아니라 방송 동일성으로
  // 판정해야, 대기 중 다음 방송이 시작된 경우(isRecording=true, 다른 broadcastId)에도 이 캡처를 고아로 본다.
  const readiness = await manager.waitUntilReady(
    CAPTURE_READY_TIMEOUT_MS,
    () => recorder.getActiveBroadcastId() !== broadcastId
  );
  // 대기 중 이 방송이 끝났으면 선기동 캡처는 고아 — 단, 다음 방송이 같은 provider 싱글턴 매니저를 이미 재기동했으면
  // 그 새 캡처를 죽이면 안 된다. 소유권이 아직 내 방송일 때만 stop한다(R3 더블클릭 정리는 유지, B 캡처 침범은 방지).
  if (recorder.getActiveBroadcastId() !== broadcastId) {
    if (shouldStopOrphanedManager(captureManagerOwner[provider], broadcastId)) {
      await manager.stop();
    }
    return "cancelled";
  }
  const plan = planFromReadiness(readiness);
  const cur = state.getStatus(provider);
  if (plan.warning) {
    appendProviderLog({ provider, sourceMode: ref.sourceMode, level: "warning", message: plan.warning });
    state.setStatus({ ...cur, message: plan.warning });
  } else {
    // 준비 완료 — 스테일 "이미지 준비 중"을 진입 전 메시지로 복원한다.
    state.setStatus({ ...cur, message: prev.message });
  }
  return readiness;
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

  // 연결 ⊥ 캡처: 연결은 채팅만 즉시 붙인다(캡처는 녹화 시작 시 기동). 캡처 선기동·준비 게이트 없음.
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
    if (!isFailureState) {
      appendProviderLog({
        provider,
        sourceMode: request.sourceMode,
        level: "success",
        channelId: adapter.getStatus().channelId ?? request.channelId,
        message: "채팅 소스 연결이 완료되었습니다."
      });
      // 녹화 중 뒤늦게 붙은 provider의 캡처 합류 — 단일 소스 모드에선 현재 방송을 소유한 슬롯이 없을 때만
      // (시작 시 캡처 가능한 provider가 0이었던 경우). 슬롯을 이 방송 스코프로 먼저 채우고 기동해
      // 다음 late-join이 이중 기동되지 않게 한다. (레거시 모드는 슬롯을 세팅하지 않아 항상 미소유 → 기존 이중 캡처.)
      const activeBroadcastId = recorder.getActiveBroadcastId();
      if (shouldCaptureLateJoin(recorder.isRecording(), captureSlot, activeBroadcastId)) {
        if (singleFrameCaptureEnabled && activeBroadcastId) {
          captureSlot = { broadcastId: activeBroadcastId, provider };
        }
        void ensureCaptureForRecording(
          { provider, sourceMode: request.sourceMode, channelId: adapter.getStatus().channelId ?? request.channelId ?? "" },
          activeBroadcastId
        ).catch((error) => app.log.error(error, "late-join 캡처 기동 중 오류가 발생했습니다."));
      }
    }
    return { ok: !isFailureState, providerStatus: adapter.getStatus(), providerStatuses: state.getStatuses() };
  } catch (error) {
    app.log.error(
      { err: error, provider, sourceMode: request.sourceMode, channelId: request.channelId },
      "채팅 소스 연결 중 오류가 발생했습니다."
    );
    currentAdapters.delete(provider);
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
  // 연결 해제는 캡처도 녹화도 끝내지 않는다(연결 ⊥ 캡처 ⊥ 녹화). 캡처는 녹화 종료(수동 stop·grace 자동종료)에서만 멈춘다.
  // 녹화 중 provider가 offline→재접속하면 매니저는 no-hls 백오프로 생존하다 스트림 복귀 시 자동 재개한다.

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
