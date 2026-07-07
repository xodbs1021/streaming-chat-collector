import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rm, stat, writeFile, appendFile } from "node:fs/promises";
import path from "node:path";
import type {
  ChatMessage,
  ChatProvider,
  ChatRecord,
  HighlightAnnotation,
  HighlightAnnotationMap,
  HighlightCategory,
  AnalyticsRankItem,
  RecordingSession,
  RecordingStatus,
  TimelineMarker,
  ViewerCountSample
} from "../shared/types";

const META_FLUSH_DELAY_MS = 5_000;

interface SerializedRecord {
  record: ChatRecord;
  line: string;
}

export class ChatRecorder {
  private activeSessions = new Map<ChatProvider, RecordingSession>();
  private sequences = new Map<ChatProvider, number>();
  private lastRecordAt: number | undefined;
  private latestActiveProvider: ChatProvider | undefined;
  private dirtyMeta = new Map<string, RecordingSession>();
  private metaFlushTimer: ReturnType<typeof setTimeout> | undefined;
  private countCache = new Map<string, { mtimeMs: number; size: number; count: number }>();
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(private readonly dataDir: string) {}

  getStatus(): RecordingStatus {
    const activeSessions = this.getActiveSessions();
    return {
      enabled: true,
      dataDir: this.dataDir,
      message: activeSessions.length > 0 ? `${activeSessions.map((session) => providerLabel(session.provider)).join(" · ")} 저장 중` : "저장 대기 중",
      activeSession: this.getActiveSession(),
      activeSessions,
      lastRecordAt: this.lastRecordAt
    };
  }

  getActiveSession(provider?: ChatProvider) {
    if (provider) {
      return this.activeSessions.get(provider);
    }
    if (this.latestActiveProvider) {
      const latest = this.activeSessions.get(this.latestActiveProvider);
      if (latest) {
        return latest;
      }
    }
    return this.getActiveSessions().at(0);
  }

  getActiveSessions() {
    return Array.from(this.activeSessions.values()).sort((left, right) => right.startedAt - left.startedAt);
  }

  async recordMessage(message: ChatMessage): Promise<ChatRecord | undefined> {
    if (message.sourceMode === "mock") {
      return undefined;
    }

    const activeSession = await this.ensureSession(message);
    if (!activeSession) {
      return undefined;
    }

    const receivedAt = Date.now();
    const nextSequence = (this.sequences.get(message.provider) ?? 0) + 1;
    const serialized = serializeRecord({
      ...message,
      sessionId: activeSession.sessionId,
      sequence: nextSequence,
      receivedAt
    });

    // 상태는 동기 갱신, 디스크 쓰기는 큐로 직렬화 —
    // 채팅 폭주 시 디스크 지연이 실시간 분석 반영을 막지 않도록 함
    this.sequences.set(message.provider, serialized.record.sequence);
    this.lastRecordAt = receivedAt;
    this.latestActiveProvider = message.provider;
    const nextSession = {
      ...activeSession,
      messageCount: activeSession.messageCount + 1
    };
    this.activeSessions.set(message.provider, nextSession);
    this.scheduleMetaWrite(nextSession);
    this.queueAppend(this.sessionFilePath(activeSession.sessionId), `${serialized.line}\n`);
    return serialized.record;
  }

  /** 대기 중인 디스크 쓰기가 모두 끝날 때까지 대기 — 종료/정리 전 호출용 */
  async flushWrites() {
    await this.writeQueue;
  }

  private queueAppend(filePath: string, line: string) {
    this.writeQueue = this.writeQueue
      .then(() => mkdir(this.dataDir, { recursive: true }))
      .then(() => appendFile(filePath, line, "utf8"))
      .catch((error) => {
        console.error("[recorder] 채팅 저장 실패:", error instanceof Error ? error.message : error);
      });
  }

  async recordViewerSample(provider: ChatProvider, count: number) {
    const activeSession = this.activeSessions.get(provider);
    if (!activeSession || !Number.isFinite(count) || count < 0) {
      return;
    }
    const sample: ViewerCountSample = { provider, timestamp: Date.now(), count: Math.round(count) };
    this.queueAppend(this.viewersFilePath(activeSession.sessionId), `${JSON.stringify(sample)}\n`);
  }

  async readViewerSamples(sessionId: string): Promise<ViewerCountSample[]> {
    await this.writeQueue;
    try {
      const content = await readFile(this.viewersFilePath(sanitizeSessionId(sessionId)), "utf8");
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

  async deleteSession(sessionId: string): Promise<"active" | "missing" | "deleted"> {
    const safeSessionId = sanitizeSessionId(sessionId);
    if (this.getActiveSessions().some((session) => session.sessionId === safeSessionId)) {
      return "active";
    }
    const session = await this.readMeta(safeSessionId);
    if (!session) {
      return "missing";
    }
    await Promise.all([
      rm(this.sessionFilePath(safeSessionId), { force: true }),
      rm(this.metaFilePath(safeSessionId), { force: true }),
      rm(this.highlightsFilePath(safeSessionId), { force: true }),
      rm(this.viewersFilePath(safeSessionId), { force: true }),
      rm(this.markersFilePath(safeSessionId), { force: true })
    ]);
    this.countCache.delete(safeSessionId);
    this.dirtyMeta.delete(safeSessionId);
    return "deleted";
  }

  async endSession(provider?: ChatProvider) {
    await this.writeQueue;
    const targetProvider = provider ?? this.getActiveSession()?.provider;
    if (!targetProvider) {
      return undefined;
    }

    const activeSession = this.activeSessions.get(targetProvider);
    if (!activeSession || activeSession.endedAt) {
      return undefined;
    }

    const ended = {
      ...activeSession,
      endedAt: Date.now()
    };
    this.dirtyMeta.delete(ended.sessionId);
    await this.writeMeta(ended);
    this.activeSessions.delete(targetProvider);
    this.sequences.delete(targetProvider);
    if (this.latestActiveProvider === targetProvider) {
      this.latestActiveProvider = this.getActiveSession()?.provider;
    }
    return ended;
  }

  async listSessions(options: { includeArchived?: boolean } = {}) {
    await mkdir(this.dataDir, { recursive: true });
    const entries = await readdir(this.dataDir);
    const sessions = await Promise.all(
      entries
        .filter((entry) => entry.endsWith(".meta.json"))
        .map(async (entry) => this.readMeta(entry.replace(/\.meta\.json$/, "")))
    );
    const sessionsWithActualCounts = await Promise.all(
      sessions
        .filter((session): session is RecordingSession => Boolean(session))
        .filter((session) => options.includeArchived || !session.archivedAt)
        .map((session) => this.withActualMessageCount(session))
    );

    return sessionsWithActualCounts.sort((left, right) => right.startedAt - left.startedAt);
  }

  async getSession(sessionId: string) {
    const session = await this.readMeta(sessionId);
    return session ? this.withActualMessageCount(session) : undefined;
  }

  async updateSessionMeta(sessionId: string, patch: { displayName?: string }) {
    const session = await this.getSession(sessionId);
    if (!session) {
      return undefined;
    }

    const displayName = sanitizeDisplayName(patch.displayName);
    const nextSession = {
      ...session,
      displayName
    };
    // 진행 중 세션이면 인메모리 사본에도 반영 — 이후 채팅 수신으로 인한
    // 주기적 meta flush나 세션 종료 기록이 이름 변경을 덮어쓰지 않도록
    this.applyMetaPatchToActiveSession(session.sessionId, { displayName });
    await this.writeMeta(nextSession);
    return nextSession;
  }

  async archiveSession(sessionId: string) {
    const session = await this.getSession(sessionId);
    if (!session) {
      return undefined;
    }

    const nextSession = {
      ...session,
      archivedAt: session.archivedAt ?? Date.now()
    };
    this.applyMetaPatchToActiveSession(session.sessionId, { archivedAt: nextSession.archivedAt });
    await this.writeMeta(nextSession);
    return nextSession;
  }

  /** 디스크 메타 패치를 인메모리 활성 세션/대기 중 flush 사본에도 동기화 */
  private applyMetaPatchToActiveSession(sessionId: string, patch: Partial<RecordingSession>) {
    for (const [provider, active] of this.activeSessions) {
      if (active.sessionId === sessionId) {
        this.activeSessions.set(provider, { ...active, ...patch });
      }
    }
    const pending = this.dirtyMeta.get(sessionId);
    if (pending) {
      this.dirtyMeta.set(sessionId, { ...pending, ...patch });
    }
  }

  async readRecords(sessionId: string) {
    await this.writeQueue;
    const safeSessionId = sanitizeSessionId(sessionId);
    const filePath = this.sessionFilePath(safeSessionId);
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

  async readHighlightAnnotations(sessionId: string): Promise<HighlightAnnotationMap> {
    try {
      const content = await readFile(this.highlightsFilePath(sanitizeSessionId(sessionId)), "utf8");
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
    const annotation = {
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
    await mkdir(this.dataDir, { recursive: true });
    await writeFile(this.highlightsFilePath(sessionId), `${JSON.stringify(annotations, null, 2)}\n`, "utf8");
    return annotation;
  }

  async deleteHighlightAnnotation(sessionId: string, candidateId: string) {
    const annotations = await this.readHighlightAnnotations(sessionId);
    const deleted = annotations[candidateId];
    if (!deleted) {
      return undefined;
    }
    delete annotations[candidateId];
    await mkdir(this.dataDir, { recursive: true });
    await writeFile(this.highlightsFilePath(sessionId), `${JSON.stringify(annotations, null, 2)}\n`, "utf8");
    return deleted;
  }

  async readMarkers(sessionId: string): Promise<TimelineMarker[]> {
    try {
      const content = await readFile(this.markersFilePath(sanitizeSessionId(sessionId)), "utf8");
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
    await mkdir(this.dataDir, { recursive: true });
    await writeFile(this.markersFilePath(sanitizeSessionId(sessionId)), `${JSON.stringify(next, null, 2)}\n`, "utf8");
    return marker;
  }

  async deleteMarker(sessionId: string, markerId: string) {
    const markers = await this.readMarkers(sessionId);
    const deleted = markers.find((marker) => marker.id === markerId);
    if (!deleted) {
      return undefined;
    }
    const next = markers.filter((marker) => marker.id !== markerId);
    await mkdir(this.dataDir, { recursive: true });
    await writeFile(this.markersFilePath(sanitizeSessionId(sessionId)), `${JSON.stringify(next, null, 2)}\n`, "utf8");
    return deleted;
  }

  private async ensureSession(message: ChatMessage) {
    const activeSession = this.activeSessions.get(message.provider);
    if (activeSession && activeSession.sourceMode === message.sourceMode && activeSession.channelId === message.channelId) {
      return activeSession;
    }

    if (activeSession) {
      await this.endSession(message.provider);
    }

    const startedAt = Date.now();
    const sessionId = buildSessionId(startedAt, message.provider, message.channelId);
    const nextSession = {
      sessionId,
      provider: message.provider,
      sourceMode: message.sourceMode,
      channelId: message.channelId,
      startedAt,
      messageCount: 0,
      fileName: `${sessionId}.jsonl`
    };
    this.activeSessions.set(message.provider, nextSession);
    this.sequences.set(message.provider, 0);
    this.latestActiveProvider = message.provider;
    await mkdir(this.dataDir, { recursive: true });
    await this.writeMeta(nextSession);
    return nextSession;
  }

  private async readMeta(sessionId: string) {
    try {
      const content = await readFile(this.metaFilePath(sanitizeSessionId(sessionId)), "utf8");
      const parsed = JSON.parse(content) as RecordingSession;
      return parsed?.sessionId ? parsed : undefined;
    } catch {
      return undefined;
    }
  }

  private async writeMeta(session: RecordingSession) {
    await mkdir(this.dataDir, { recursive: true });
    await writeFile(this.metaFilePath(session.sessionId), `${JSON.stringify(session, null, 2)}\n`, "utf8");
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
        await this.writeMeta(session);
      } catch {
        // 다음 flush 주기에 다시 시도된다.
      }
    }
  }

  private async withActualMessageCount(session: RecordingSession) {
    const messageCount = await this.countReadableRecords(session.sessionId);
    return { ...session, messageCount };
  }

  private async countReadableRecords(sessionId: string) {
    const safeSessionId = sanitizeSessionId(sessionId);
    const filePath = this.sessionFilePath(safeSessionId);
    let fileStat;
    try {
      fileStat = await stat(filePath);
    } catch {
      return 0;
    }

    const cached = this.countCache.get(safeSessionId);
    if (cached && cached.mtimeMs === fileStat.mtimeMs && cached.size === fileStat.size) {
      return cached.count;
    }

    const content = await readFile(filePath, "utf8");
    const count = content
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .reduce((total, line) => total + (parseRecord(line) ? 1 : 0), 0);
    this.countCache.set(safeSessionId, { mtimeMs: fileStat.mtimeMs, size: fileStat.size, count });
    return count;
  }

  private sessionFilePath(sessionId: string) {
    return path.join(this.dataDir, `${sanitizeSessionId(sessionId)}.jsonl`);
  }

  private metaFilePath(sessionId: string) {
    return path.join(this.dataDir, `${sanitizeSessionId(sessionId)}.meta.json`);
  }

  private highlightsFilePath(sessionId: string) {
    return path.join(this.dataDir, `${sanitizeSessionId(sessionId)}.highlights.json`);
  }

  private viewersFilePath(sessionId: string) {
    return path.join(this.dataDir, `${sanitizeSessionId(sessionId)}.viewers.jsonl`);
  }

  private markersFilePath(sessionId: string) {
    return path.join(this.dataDir, `${sanitizeSessionId(sessionId)}.markers.json`);
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

export function buildSessionId(timestamp: number, provider: ChatMessage["provider"], channelId: string) {
  return `${formatSessionTimestamp(timestamp)}-${provider}-${sanitizeFilePart(channelId || "unknown")}`;
}

export function sanitizeFilePart(input: string) {
  const sanitized = input
    .normalize("NFKD")
    .replace(/[^\w-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return sanitized || "unknown";
}

function sanitizeSessionId(input: string) {
  return input
    .normalize("NFKD")
    .replace(/[^\w-]+/g, "-")
    .replace(/^-+|-+$/g, "") || "unknown";
}

function sanitizeDisplayName(input: string | undefined) {
  const trimmed = input?.trim().slice(0, 80);
  return trimmed || undefined;
}

function formatSessionTimestamp(timestamp: number) {
  const date = new Date(timestamp);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
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
