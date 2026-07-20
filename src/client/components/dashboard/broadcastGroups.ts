import type { ChatProvider, RecordingSession } from "../../../shared/types";
import { PROVIDER_ORDER } from "../../frameProviderSelection";

/**
 * 방송(broadcast) 뷰모델 — 평면 RecordingSession[]을 방송 단위로 묶은 클라 전용 그룹.
 * 서버는 이 shape을 방출/소비하지 않는다(경계 안 넘음). shared의 BroadcastSession(내구 모델)과는 다른 관심사.
 */
export interface BroadcastGroup {
  /** broadcastId ?? sessionId(레거시 폴백) — 사이드바 행 key */
  groupKey: string;
  broadcastId?: string;
  /** PROVIDER_ORDER상 첫 truthy displayName */
  displayName?: string;
  /** 그룹 정렬 키 — 형제 중 최소 startedAt */
  startedAt: number;
  /** 형제 messageCount 합 */
  totalMessageCount: number;
  /** provider별 형제 세션 — PROVIDER_ORDER(chzzk→soop) 정렬 */
  sessions: RecordingSession[];
}

function providerRank(provider: ChatProvider): number {
  const index = PROVIDER_ORDER.indexOf(provider);
  return index === -1 ? PROVIDER_ORDER.length : index;
}

function sortByProviderOrder(sessions: RecordingSession[]): RecordingSession[] {
  return [...sessions].sort((left, right) => providerRank(left.provider) - providerRank(right.provider));
}

function buildGroup(groupKey: string, bucket: RecordingSession[]): BroadcastGroup {
  const sessions = sortByProviderOrder(bucket);
  return {
    groupKey,
    broadcastId: sessions.find((session) => session.broadcastId)?.broadcastId,
    displayName: sessions.find((session) => session.displayName)?.displayName,
    startedAt: Math.min(...sessions.map((session) => session.startedAt)),
    totalMessageCount: sessions.reduce((sum, session) => sum + session.messageCount, 0),
    sessions
  };
}

/** 평면 세션 목록을 방송 그룹으로 묶고 최신 방송(startedAt 내림차순)이 위로 오게 정렬한다. */
export function groupSessionsByBroadcast(sessions: RecordingSession[]): BroadcastGroup[] {
  const byKey = new Map<string, RecordingSession[]>();
  for (const session of sessions) {
    const key = session.broadcastId ?? session.sessionId;
    const bucket = byKey.get(key);
    if (bucket) {
      bucket.push(session);
    } else {
      byKey.set(key, [session]);
    }
  }
  const groups: BroadcastGroup[] = [];
  for (const [groupKey, bucket] of byKey) {
    groups.push(buildGroup(groupKey, bucket));
  }
  return groups.sort((left, right) => right.startedAt - left.startedAt);
}

/** 선택된 세션이 속한 그룹(=탭 형제들)을 찾는다. 소속 그룹이 없으면(예: "live") undefined. */
export function findGroupOf(groups: BroadcastGroup[], sessionId: string): BroadcastGroup | undefined {
  return groups.find((group) => group.sessions.some((session) => session.sessionId === sessionId));
}

/** 방송 클릭 시 기본 선택 provider — messageCount 최다, 동률이면 PROVIDER_ORDER상 먼저(=chzzk). */
export function defaultSessionOf(group: BroadcastGroup): RecordingSession {
  let best = group.sessions[0];
  for (const session of group.sessions) {
    if (session.messageCount > best.messageCount) {
      best = session;
    }
  }
  return best;
}
