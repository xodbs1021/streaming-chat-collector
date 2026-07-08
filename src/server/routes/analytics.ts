import type { FastifyInstance } from "fastify";
import {
  LiveAnalytics,
  computeOverallParticipationRate,
  summarizeChatRecords,
  summarizeHighlightCandidates,
  summarizeWindowComparison
} from "../analytics";
import { ChatRecorder } from "../recorder";
import type { AppSocketServer } from "../state";
import type {
  AnalyticsRankItem,
  ChatRecord,
  HighlightCategory,
  ViewerCountSample,
  WindowComparisonSummary
} from "../../shared/types";
import { readKeywords, readOptionalNumber, readWindowSec } from "./params";

interface AnalyticsRouteDeps {
  recorder: ChatRecorder;
  liveAnalytics: LiveAnalytics;
  io: AppSocketServer;
}

const LIVE_COMPARISON_CACHE_MS = 5_000;
const highlightCategories = new Set<HighlightCategory>([
  "teamfight",
  "player_mistake",
  "objective",
  "solo_kill",
  "pentakill",
  "macro",
  "other"
]);

export function registerAnalyticsRoutes(app: FastifyInstance, deps: AnalyticsRouteDeps) {
  const { recorder, liveAnalytics, io } = deps;
  let liveComparisonCache: { generatedAt: number; payload: WindowComparisonSummary } | undefined;

  app.get("/api/analytics/sessions", async () => recorder.listSessions());

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
      ? `# 전체 방송 참여율(평균 시청자 대비): ${Math.round(overallParticipationRate * 1000) / 10}%`
      : undefined;
  const allLines = [summaryComment, header, ...lines].filter((line): line is string => Boolean(line));
  return `﻿${allLines.join("\n")}\n`;
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
