import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rm, stat, writeFile, appendFile } from "node:fs/promises";
import path from "node:path";
import type {
  BroadcastProviderRef,
  BroadcastSession,
  ChatMessage,
  ChatProvider,
  ChatRecord,
  HighlightAnnotation,
  HighlightAnnotationMap,
  HighlightCategory,
  AnalyticsRankItem,
  RecordingSession,
  RecordingState,
  RecordingStatus,
  TimelineMarker,
  ViewerCountSample
} from "../shared/types";
import { BroadcastPaths } from "./broadcast/broadcastPaths";
import { createBroadcastId } from "./broadcast/broadcastId";
import { composeSessionKey, parseSessionKey } from "./broadcast/sessionKey";

const META_FLUSH_DELAY_MS = 5_000;

/** 현재 저장 중인 방송 1개 — 방송 메타 + provider별 세션 맵. */
interface ActiveBroadcast {
  session: BroadcastSession;
  providers: Map<ChatProvider, RecordingSession>;
}

/** sessionId를 broadcastId+provider로 되돌린 위치 정보(경로 조립용). */
interface SessionLocation {
  broadcastId: string;
  provider: ChatProvider;
}

interface SerializedRecord {
  record: ChatRecord;
  line: string;
}

/**
 * 방송(broadcast) 단위 채팅 저장소. "연결"과 무관하게, 명시적으로 녹화를 시작해야 저장한다.
 * 저장 레이아웃은 `<dataDir>/<broadcastId>/chat/<provider>/…` (경로는 BroadcastPaths가 단일 진실원).
 * 외부(라우트)에는 provider 세션을 `<broadcastId>__<provider>` 합성 sessionId로 노출한다.
 */
export class ChatRecorder {
  private readonly paths: BroadcastPaths;
  private activeBroadcast: ActiveBroadcast | undefined;
  // 자동종료 유예(grace) 여부 — 타이머는 index.ts가 소유하고, 상태 방출용으로 이 플래그를 알려준다.
  private autoStopPending = false;
  private sequences = new Map<ChatProvider, number>();
  private lastRecordAt: number | undefined;
  private latestActiveProvider: ChatProvider | undefined;
  private dirtyMeta = new Map<string, RecordingSession>();
  private metaFlushTimer: ReturnType<typeof setTimeout> | undefined;
  private countCache = new Map<string, { mtimeMs: number; size: number; count: number }>();
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(private readonly dataDir: string) {
    this.paths = new BroadcastPaths(dataDir);
  }

  // ── 녹화 라이프사이클 ────────────────────────────────────────────────

  isRecording(): boolean {
    return this.activeBroadcast !== undefined;
  }

  getActiveBroadcastId(): string | undefined {
    return this.activeBroadcast?.session.broadcastId;
  }

  /**
   * 자동종료 유예(grace) 진입/해제를 상태 방출에 반영한다. recorder는 grace 타이머를 소유하지 않으므로
   * 정책 주체(index.ts)가 schedule/cancel 시점에 알려준다 — getStatus의 recordingState가 "grace"로 나가게 한다.
   */
  setAutoStopPending(pending: boolean) {
    this.autoStopPending = pending;
  }

  /**
   * 녹화를 시작한다 — broadcastId를 발급하고 방송/ provider 디렉토리와 메타를 연다.
   * 이미 녹화 중이면 현재 방송을 그대로 반환(idempotent). provider가 하나도 없으면 시작하지 않는다.
   */
  async startRecording(providers: BroadcastProviderRef[]): Promise<BroadcastSession | undefined> {
    if (this.activeBroadcast) {
      return this.activeBroadcast.session;
    }
    if (providers.length === 0) {
      return undefined;
    }
    const startedAt = Date.now();
    const broadcastId = createBroadcastId(new Date(startedAt));
    this.activeBroadcast = {
      session: { broadcastId, startedAt, providers: [] },
      providers: new Map()
    };
    this.sequences.clear();
    this.latestActiveProvider = undefined;
    this.autoStopPending = false;
    await mkdir(this.paths.broadcastDir(broadcastId), { recursive: true });
    for (const ref of providers) {
      await this.openProviderSession(ref, startedAt);
    }
    await this.writeBroadcastMeta(this.activeBroadcast.session);
    return this.activeBroadcast.session;
  }

  /** 녹화를 종료한다 — 방송/ provider 메타에 endedAt을 기록하고 활성 상태를 비운다. 비녹화면 undefined. */
  async stopRecording(): Promise<BroadcastSession | undefined> {
    const active = this.activeBroadcast;
    if (!active) {
      return undefined;
    }
    // 먼저 활성 상태를 비워, 종료 처리 중 도착하는 메시지가 endedAt 이후에 append되지 않게 한다
    // (recordMessage는 activeBroadcast가 없으면 디스크에 쓰지 않는다). 그다음 이미 큐에 쌓인
    // 쓰기를 모두 흘려보내고 종료 메타를 기록한다.
    this.activeBroadcast = undefined;
    this.autoStopPending = false;
    await this.writeQueue;
    const endedAt = Date.now();
    for (const session of active.providers.values()) {
      this.dirtyMeta.delete(session.sessionId);
      await this.writeProviderMeta({ ...session, endedAt });
    }
    const endedBroadcast: BroadcastSession = { ...active.session, endedAt };
    await this.writeBroadcastMeta(endedBroadcast);
    this.sequences.clear();
    this.latestActiveProvider = undefined;
    return endedBroadcast;
  }

  // ── 실시간 기록 ─────────────────────────────────────────────────────

  /**
   * 메시지를 처리한다. 녹화 중이면 디스크에 저장하고, 아니어도 라이브 분석용 ChatRecord는 반환한다
   * (연결=대시보드 표시가 녹화와 무관하게 유지되도록). mock은 무시.
   */
  async recordMessage(message: ChatMessage): Promise<ChatRecord | undefined> {
    if (message.sourceMode === "mock") {
      return undefined;
    }

    const receivedAt = Date.now();
    const provider = message.provider;
    const providerSession = this.activeBroadcast ? await this.ensureProviderSession(message) : undefined;

    const nextSequence = (this.sequences.get(provider) ?? 0) + 1;
    this.sequences.set(provider, nextSequence);
    this.lastRecordAt = receivedAt;

    const serialized = serializeRecord({
      ...message,
      sessionId: providerSession?.sessionId ?? "",
      sequence: nextSequence,
      receivedAt
    });

    if (providerSession && this.activeBroadcast) {
      // 상태는 동기 갱신, 디스크 쓰기는 큐로 직렬화 — 채팅 폭주 시 디스크 지연이 분석 반영을 막지 않도록.
      this.latestActiveProvider = provider;
      const nextSession = { ...providerSession, messageCount: providerSession.messageCount + 1 };
      this.activeBroadcast.providers.set(provider, nextSession);
      this.scheduleMetaWrite(nextSession);
      this.queueAppend(this.paths.chatFilePath(nextSession.broadcastId ?? "", provider), `${serialized.line}\n`);
    }
    return serialized.record;
  }

  /** 대기 중인 디스크 쓰기가 모두 끝날 때까지 대기 — 종료/정리 전 호출용 */
  async flushWrites() {
    await this.writeQueue;
  }

  async recordViewerSample(provider: ChatProvider, count: number) {
    const session = this.activeBroadcast?.providers.get(provider);
    if (!session || !Number.isFinite(count) || count < 0) {
      return;
    }
    const sample: ViewerCountSample = { provider, timestamp: Date.now(), count: Math.round(count) };
    this.queueAppend(this.paths.viewersFilePath(session.broadcastId ?? "", provider), `${JSON.stringify(sample)}\n`);
  }

  // ── 상태 조회 ───────────────────────────────────────────────────────

  getStatus(): RecordingStatus {
    const activeSessions = this.getActiveSessions();
    const recordingState: RecordingState = this.activeBroadcast
      ? this.autoStopPending
        ? "grace"
        : "recording"
      : "idle";
    return {
      enabled: true,
      dataDir: this.dataDir,
      message:
        activeSessions.length > 0
          ? `${activeSessions.map((session) => providerLabel(session.provider)).join(" · ")} 저장 중`
          : "저장 대기 중",
      recordingState,
      activeBroadcastId: this.activeBroadcast?.session.broadcastId,
      activeSession: this.getActiveSession(),
      activeSessions,
      lastRecordAt: this.lastRecordAt
    };
  }

  getActiveSession(provider?: ChatProvider) {
    if (!this.activeBroadcast) {
      return undefined;
    }
    if (provider) {
      return this.activeBroadcast.providers.get(provider);
    }
    if (this.latestActiveProvider) {
      const latest = this.activeBroadcast.providers.get(this.latestActiveProvider);
      if (latest) {
        return latest;
      }
    }
    return this.getActiveSessions().at(0);
  }

  getActiveSessions() {
    if (!this.activeBroadcast) {
      return [];
    }
    return Array.from(this.activeBroadcast.providers.values()).sort((left, right) => right.startedAt - left.startedAt);
  }

  // ── 세션 목록·읽기 (라우트가 합성 sessionId로 호출) ───────────────────

  async listSessions(options: { includeArchived?: boolean } = {}) {
    await mkdir(this.dataDir, { recursive: true });
    const entries = await readdir(this.dataDir, { withFileTypes: true });
    const broadcastDirs = entries.filter((entry) => entry.isDirectory());

    const sessions: RecordingSession[] = [];
    for (const dir of broadcastDirs) {
      const broadcast = await this.readBroadcastMeta(dir.name);
      if (!broadcast) {
        continue;
      }
      for (const ref of broadcast.providers) {
        const session = await this.readProviderMeta(broadcast.broadcastId, ref.provider);
        if (session) {
          sessions.push(session);
        }
      }
    }

    const withCounts = await Promise.all(
      sessions
        .filter((session) => options.includeArchived || !session.archivedAt)
        .map((session) => this.withActualMessageCount(session))
    );
    return withCounts.sort((left, right) => right.startedAt - left.startedAt);
  }

  async getSession(sessionId: string) {
    const location = this.locate(sessionId);
    if (!location) {
      return undefined;
    }
    const session = await this.readProviderMeta(location.broadcastId, location.provider);
    return session ? this.withActualMessageCount(session) : undefined;
  }

  async readRecords(sessionId: string) {
    await this.writeQueue;
    const location = this.locate(sessionId);
    if (!location) {
      return [];
    }
    const filePath = this.paths.chatFilePath(location.broadcastId, location.provider);
    try {
      await stat(filePath);
    } catch {
      return [];
    }
    const content = await readFile(filePath, "utf8");
    return content
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => parseRecord(line))
      .filter((record): record is ChatRecord => Boolean(record));
  }

  async readViewerSamples(sessionId: string): Promise<ViewerCountSample[]> {
    await this.writeQueue;
    const location = this.locate(sessionId);
    if (!location) {
      return [];
    }
    try {
      const content = await readFile(this.paths.viewersFilePath(location.broadcastId, location.provider), "utf8");
      return content
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => parseViewerSample(line))
        .filter((sample): sample is ViewerCountSample => Boolean(sample));
    } catch {
      return [];
    }
  }

  /** 세션 삭제 = 그 provider 세션의 저장물 전체(chat + frame) 삭제.
   *  frame·chat 삭제 성공 시점에 계약상 삭제 완료("deleted").
   *  마지막 provider가 지워지면 방송 폴더 정리는 베스트 에포트 — 실패해도 로그만 남기고 "deleted"를 반환한다. */
  async deleteSession(sessionId: string): Promise<"active" | "missing" | "deleted"> {
    const location = this.locate(sessionId);
    if (!location) {
      return "missing";
    }
    const compositeId = composeSessionKey(location.broadcastId, location.provider);
    if (this.getActiveSessions().some((session) => session.sessionId === compositeId)) {
      return "active";
    }
    const session = await this.readProviderMeta(location.broadcastId, location.provider);
    if (!session) {
      return "missing";
    }
    // frame 먼저, chat 나중 — chat/<provider>/meta.json이 세션 가시성 앵커라, frame rm이 실패하면
    // 세션이 목록에 남아 재시도할 수 있다(반대 순서면 고아 프레임이 어떤 세션으로도 접근 불가로 잔존).
    await rm(this.paths.frameDir(location.broadcastId, location.provider), { recursive: true, force: true });
    await rm(this.paths.chatDir(location.broadcastId, location.provider), { recursive: true, force: true });
    this.countCache.delete(session.sessionId);
    this.dirtyMeta.delete(session.sessionId);
    await this.removeBroadcastDirIfEmpty(location.broadcastId);
    return "deleted";
  }

  /** 방송에 provider 세션(meta.json)이 하나도 안 남았으면 방송 폴더(husk)를 통째로 지운다.
   *  실패는 전파하지 않고 로그만 — 여기서 던지면 재시도가 meta 부재로 "missing"이 되어 정리 코드에 재도달 못 한다. */
  private async removeBroadcastDirIfEmpty(broadcastId: string): Promise<void> {
    try {
      if (await this.hasAnyProviderMeta(broadcastId)) {
        return;
      }
      await rm(this.paths.broadcastDir(broadcastId), { recursive: true, force: true });
    } catch (error) {
      console.error("[recorder] 빈 방송 폴더 정리 실패:", error instanceof Error ? error.message : error);
    }
  }

  /** 닫힌 provider 합집합 각각의 meta.json 존재를 확인한다 — 하나라도 있으면 방송이 아직 산다. */
  private async hasAnyProviderMeta(broadcastId: string): Promise<boolean> {
    for (const provider of ["chzzk", "soop"] as const) {
      try {
        await stat(this.paths.metaFilePath(broadcastId, provider));
        return true;
      } catch {
        // 이 provider 세션 없음 — 다음 provider 확인.
      }
    }
    return false;
  }

  async updateSessionMeta(sessionId: string, patch: { displayName?: string }) {
    const session = await this.getSession(sessionId);
    if (!session) {
      return undefined;
    }
    const displayName = sanitizeDisplayName(patch.displayName);
    const nextSession = { ...session, displayName };
    // 진행 중 세션이면 인메모리 사본에도 반영 — 이후 meta flush나 종료 기록이 이름 변경을 덮어쓰지 않도록.
    this.applyMetaPatchToActiveSession(session.sessionId, { displayName });
    await this.writeProviderMeta(nextSession);
    return nextSession;
  }

  async archiveSession(sessionId: string) {
    const session = await this.getSession(sessionId);
    if (!session) {
      return undefined;
    }
    const nextSession = { ...session, archivedAt: session.archivedAt ?? Date.now() };
    this.applyMetaPatchToActiveSession(session.sessionId, { archivedAt: nextSession.archivedAt });
    await this.writeProviderMeta(nextSession);
    return nextSession;
  }

  // ── 하이라이트 주석 ─────────────────────────────────────────────────

  async readHighlightAnnotations(sessionId: string): Promise<HighlightAnnotationMap> {
    const location = this.locate(sessionId);
    if (!location) {
      return {};
    }
    try {
      const content = await readFile(this.paths.highlightsFilePath(location.broadcastId, location.provider), "utf8");
      const parsed = JSON.parse(content) as HighlightAnnotationMap;
      return Object.fromEntries(
        Object.entries(parsed).filter(([, annotation]) => Boolean(annotation?.candidateId && annotation?.category))
      );
    } catch {
      return {};
    }
  }

  async writeHighlightAnnotation(
    sessionId: string,
    candidateId: string,
    patch: {
      category?: HighlightCategory;
      note?: string;
      startAt?: number;
      endAt?: number;
      windowSec?: number;
      peakCount?: number;
      totalMessages?: number;
      topTerms?: AnalyticsRankItem[];
    }
  ): Promise<HighlightAnnotation> {
    const annotations = await this.readHighlightAnnotations(sessionId);
    const previous = annotations[candidateId];
    const now = Date.now();
    const annotation: HighlightAnnotation = {
      candidateId,
      category: patch.category ?? previous?.category ?? "other",
      note: patch.note ?? previous?.note ?? "",
      startAt: patch.startAt ?? previous?.startAt,
      endAt: patch.endAt ?? previous?.endAt,
      windowSec: patch.windowSec ?? previous?.windowSec,
      peakCount: patch.peakCount ?? previous?.peakCount,
      totalMessages: patch.totalMessages ?? previous?.totalMessages,
      topTerms: patch.topTerms ?? previous?.topTerms,
      createdAt: previous?.createdAt ?? now,
      updatedAt: now
    };
    annotations[candidateId] = annotation;
    await this.writeJsonForSession(sessionId, (loc) => this.paths.highlightsFilePath(loc.broadcastId, loc.provider), annotations);
    return annotation;
  }

  async deleteHighlightAnnotation(sessionId: string, candidateId: string) {
    const annotations = await this.readHighlightAnnotations(sessionId);
    const deleted = annotations[candidateId];
    if (!deleted) {
      return undefined;
    }
    delete annotations[candidateId];
    await this.writeJsonForSession(sessionId, (loc) => this.paths.highlightsFilePath(loc.broadcastId, loc.provider), annotations);
    return deleted;
  }

  // ── 타임라인 마커 ───────────────────────────────────────────────────

  async readMarkers(sessionId: string): Promise<TimelineMarker[]> {
    const location = this.locate(sessionId);
    if (!location) {
      return [];
    }
    try {
      const content = await readFile(this.paths.markersFilePath(location.broadcastId, location.provider), "utf8");
      const parsed = JSON.parse(content) as TimelineMarker[];
      if (!Array.isArray(parsed)) {
        return [];
      }
      return parsed
        .filter(
          (marker): marker is TimelineMarker =>
            Boolean(marker && typeof marker === "object" && marker.id && typeof marker.label === "string") &&
            Number.isFinite(marker.timestamp)
        )
        .sort((left, right) => left.timestamp - right.timestamp);
    } catch {
      return [];
    }
  }

  async writeMarker(sessionId: string, input: { timestamp: number; label: string; endAt?: number }): Promise<TimelineMarker> {
    const markers = await this.readMarkers(sessionId);
    const marker: TimelineMarker = {
      id: randomUUID(),
      label: input.label,
      timestamp: input.timestamp,
      ...(input.endAt !== undefined && input.endAt > input.timestamp ? { endAt: input.endAt } : {}),
      createdAt: Date.now()
    };
    const next = [...markers, marker].sort((left, right) => left.timestamp - right.timestamp);
    await this.writeJsonForSession(sessionId, (loc) => this.paths.markersFilePath(loc.broadcastId, loc.provider), next);
    return marker;
  }

  async deleteMarker(sessionId: string, markerId: string) {
    const markers = await this.readMarkers(sessionId);
    const deleted = markers.find((marker) => marker.id === markerId);
    if (!deleted) {
      return undefined;
    }
    const next = markers.filter((marker) => marker.id !== markerId);
    await this.writeJsonForSession(sessionId, (loc) => this.paths.markersFilePath(loc.broadcastId, loc.provider), next);
    return deleted;
  }

  // ── 내부: 세션 열기/메타 ────────────────────────────────────────────

  /** 녹화 중 아직 없는 provider의 메시지가 오면 그 provider 세션을 방송에 합류시킨다. */
  private async ensureProviderSession(message: ChatMessage): Promise<RecordingSession> {
    const active = this.activeBroadcast;
    if (!active) {
      throw new Error("ensureProviderSession은 녹화 중에만 호출된다.");
    }
    const existing = active.providers.get(message.provider);
    if (existing) {
      return existing;
    }
    return this.openProviderSession(
      { provider: message.provider, sourceMode: message.sourceMode, channelId: message.channelId },
      Date.now()
    );
  }

  private async openProviderSession(ref: BroadcastProviderRef, startedAt: number): Promise<RecordingSession> {
    const active = this.activeBroadcast;
    if (!active) {
      throw new Error("openProviderSession은 녹화 중에만 호출된다.");
    }
    const broadcastId = active.session.broadcastId;
    const session: RecordingSession = {
      sessionId: composeSessionKey(broadcastId, ref.provider),
      broadcastId,
      provider: ref.provider,
      sourceMode: ref.sourceMode,
      channelId: ref.channelId,
      startedAt,
      messageCount: 0,
      fileName: path.join("chat", ref.provider, "chat.jsonl")
    };
    active.providers.set(ref.provider, session);
    const isNewProvider = !active.session.providers.some((entry) => entry.provider === ref.provider);
    if (isNewProvider) {
      active.session.providers = [...active.session.providers, ref];
    }
    this.sequences.set(ref.provider, 0);
    await mkdir(this.paths.chatDir(broadcastId, ref.provider), { recursive: true });
    await this.writeProviderMeta(session);
    // 새 provider가 방송에 합류하면 broadcast.meta의 providers를 즉시 갱신한다
    // (녹화 시작 후 뒤늦게 연결된 provider도 listSessions에 바로 잡히도록).
    if (isNewProvider) {
      await this.writeBroadcastMeta(active.session);
    }
    return session;
  }

  private async readProviderMeta(broadcastId: string, provider: ChatProvider): Promise<RecordingSession | undefined> {
    try {
      const content = await readFile(this.paths.metaFilePath(broadcastId, provider), "utf8");
      const parsed = JSON.parse(content) as RecordingSession;
      return parsed?.sessionId ? parsed : undefined;
    } catch {
      return undefined;
    }
  }

  private async writeProviderMeta(session: RecordingSession) {
    const location = this.locate(session.sessionId);
    if (!location) {
      return;
    }
    await this.ensureDir(this.paths.chatDir(location.broadcastId, location.provider));
    await writeFile(this.paths.metaFilePath(location.broadcastId, location.provider), `${JSON.stringify(session, null, 2)}\n`, "utf8");
  }

  private async readBroadcastMeta(broadcastId: string): Promise<BroadcastSession | undefined> {
    try {
      const content = await readFile(this.paths.broadcastMetaPath(broadcastId), "utf8");
      const parsed = JSON.parse(content) as BroadcastSession;
      return parsed?.broadcastId ? parsed : undefined;
    } catch {
      return undefined;
    }
  }

  private async writeBroadcastMeta(session: BroadcastSession) {
    await this.ensureDir(this.paths.broadcastDir(session.broadcastId));
    await writeFile(this.paths.broadcastMetaPath(session.broadcastId), `${JSON.stringify(session, null, 2)}\n`, "utf8");
  }

  private scheduleMetaWrite(session: RecordingSession) {
    this.dirtyMeta.set(session.sessionId, session);
    if (this.metaFlushTimer) {
      return;
    }
    this.metaFlushTimer = setTimeout(() => {
      this.metaFlushTimer = undefined;
      void this.flushDirtyMeta();
    }, META_FLUSH_DELAY_MS);
    (this.metaFlushTimer as { unref?: () => void }).unref?.();
  }

  private async flushDirtyMeta() {
    const pending = Array.from(this.dirtyMeta.values());
    this.dirtyMeta.clear();
    for (const session of pending) {
      try {
        await this.writeProviderMeta(session);
      } catch {
        // 다음 flush 주기에 다시 시도된다.
      }
    }
  }

  /** 디스크 메타 패치를 인메모리 활성 세션/대기 중 flush 사본에도 동기화 */
  private applyMetaPatchToActiveSession(sessionId: string, patch: Partial<RecordingSession>) {
    if (this.activeBroadcast) {
      for (const [provider, active] of this.activeBroadcast.providers) {
        if (active.sessionId === sessionId) {
          this.activeBroadcast.providers.set(provider, { ...active, ...patch });
        }
      }
    }
    const pending = this.dirtyMeta.get(sessionId);
    if (pending) {
      this.dirtyMeta.set(sessionId, { ...pending, ...patch });
    }
  }

  // ── 내부: 카운트·경로·직렬화 ───────────────────────────────────────

  private async withActualMessageCount(session: RecordingSession) {
    const messageCount = await this.countReadableRecords(session);
    return { ...session, messageCount };
  }

  private async countReadableRecords(session: RecordingSession) {
    const location = this.locate(session.sessionId);
    if (!location) {
      return 0;
    }
    const filePath = this.paths.chatFilePath(location.broadcastId, location.provider);
    let fileStat;
    try {
      fileStat = await stat(filePath);
    } catch {
      return 0;
    }
    const cached = this.countCache.get(session.sessionId);
    if (cached && cached.mtimeMs === fileStat.mtimeMs && cached.size === fileStat.size) {
      return cached.count;
    }
    const content = await readFile(filePath, "utf8");
    const count = content
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .reduce((total, line) => total + (parseRecord(line) ? 1 : 0), 0);
    this.countCache.set(session.sessionId, { mtimeMs: fileStat.mtimeMs, size: fileStat.size, count });
    return count;
  }

  /** 합성 sessionId를 검증된 broadcastId+provider로 되돌린다(경로 이탈 방지 sanitize 포함). */
  private locate(sessionId: string): SessionLocation | undefined {
    const parsed = parseSessionKey(sessionId);
    if (!parsed) {
      return undefined;
    }
    const broadcastId = sanitizeSegment(parsed.broadcastId);
    if (!broadcastId) {
      return undefined;
    }
    return { broadcastId, provider: parsed.provider };
  }

  private queueAppend(filePath: string, line: string) {
    this.writeQueue = this.writeQueue
      .then(() => this.ensureDir(path.dirname(filePath)))
      .then(() => appendFile(filePath, line, "utf8"))
      .catch((error) => {
        console.error("[recorder] 채팅 저장 실패:", error instanceof Error ? error.message : error);
      });
  }

  /** 세션 경로 아래에 JSON 파일 하나를 통째로 쓴다(마커·하이라이트 공용). loc이 없으면 무시. */
  private async writeJsonForSession(sessionId: string, resolvePath: (location: SessionLocation) => string, value: unknown) {
    const location = this.locate(sessionId);
    if (!location) {
      return;
    }
    const filePath = resolvePath(location);
    await this.ensureDir(path.dirname(filePath));
    await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  }

  private async ensureDir(dir: string) {
    await mkdir(dir, { recursive: true });
  }
}

function parseViewerSample(line: string) {
  try {
    const parsed = JSON.parse(line) as ViewerCountSample;
    if (!parsed || typeof parsed !== "object") {
      return undefined;
    }
    return Number.isFinite(parsed.timestamp) && Number.isFinite(parsed.count) && parsed.provider ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function providerLabel(provider: ChatProvider) {
  return provider === "soop" ? "SOOP" : "CHZZK";
}

/** 경로 세그먼트에서 `..`·구분자 등 위험 문자를 제거한다(디렉토리 이탈 방지). */
function sanitizeSegment(input: string) {
  return (
    input
      .normalize("NFKD")
      .replace(/[^\w-]+/g, "-")
      .replace(/^-+|-+$/g, "") || ""
  );
}

function sanitizeDisplayName(input: string | undefined) {
  const trimmed = input?.trim().slice(0, 80);
  return trimmed || undefined;
}

function serializeRecord(record: ChatRecord): SerializedRecord {
  try {
    return { record, line: JSON.stringify(record) };
  } catch {
    const fallback = {
      ...record,
      raw: { serializationError: true }
    };
    return { record: fallback, line: JSON.stringify(fallback) };
  }
}

function parseRecord(line: string) {
  try {
    const parsed = JSON.parse(line) as ChatRecord;
    return parsed?.messageId ? parsed : undefined;
  } catch {
    return undefined;
  }
}
