import { nearestFrameSecond } from "../shared/frameSeconds";
import type { AnalyticsWindow, ChatProvider } from "../shared/types";

export const PROVIDER_ORDER: ChatProvider[] = ["chzzk", "soop"];
const FRAME_MATCH_TOLERANCE_SEC = 15;

/** dominant도 세션 provider도 없을 때(라이브 병합 뷰의 빈 구간) 마지막으로 기대는 플랫폼 */
export const DEFAULT_PROVIDER: ChatProvider = "chzzk";

/** 세션 선택 상태에서 라이브(여러 방송 병합) 뷰를 가리키는 센티넬 id */
const LIVE_SESSION_ID = "live";

/** providerCounts 중 채팅량이 더 많은 플랫폼을 고른다. 동률이면 치지직 우선, 둘 다 0이면 undefined */
export function dominantProvider(counts: Partial<Record<ChatProvider, number>>): ChatProvider | undefined {
  let best: ChatProvider | undefined;
  let bestCount = 0;
  for (const provider of PROVIDER_ORDER) {
    const count = counts[provider] ?? 0;
    if (count > bestCount) {
      best = provider;
      bestCount = count;
    }
  }
  return best;
}

/**
 * 이 윈도우/구간에서 프레임을 보여줄 primary 플랫폼을 정한다.
 * 채팅이 있으면 채팅량이 많은 쪽(dominant), 채팅이 없던 빈 구간이면 그 세션의 provider,
 * 세션도 없는 라이브 병합 뷰면 DEFAULT_PROVIDER. 하드코딩 chzzk 폴백을 문맥 인지형으로 대체한다.
 */
export function resolvePrimaryProvider(
  counts: Partial<Record<ChatProvider, number>>,
  sessionProvider?: ChatProvider
): ChatProvider {
  return dominantProvider(counts) ?? sessionProvider ?? DEFAULT_PROVIDER;
}

/**
 * 세션 탭의 채팅 없는 빈 구간에서 프레임 폴백에 쓸 provider를 정한다.
 * 라이브(병합) 뷰(selectedSessionId === "live")면 undefined를 돌려 기존 dominant→chzzk 폴백을 그대로 두고,
 * 특정 세션 탭이면 그 세션의 provider를 폴백으로 넘긴다(provider를 모르면 undefined 그대로).
 * 라이브에서 특정 provider를 넘기면 병합 뷰의 폴백 동작이 깨지므로 undefined 유지가 불변식이다.
 */
export function resolveSessionFallbackProvider(
  selectedSessionId: string,
  selectedSessionProvider: ChatProvider | undefined
): ChatProvider | undefined {
  return selectedSessionId === LIVE_SESSION_ID ? undefined : selectedSessionProvider;
}

/** 두 플랫폼 중 주어진 것의 반대쪽 — 프레임 폴백 순서를 정할 때 쓴다 */
export function otherProvider(provider: ChatProvider): ChatProvider {
  return provider === "chzzk" ? "soop" : "chzzk";
}

/** 여러 윈도우에 걸친 providerCounts를 합산한다 (선택 구간 전체의 dominant provider 계산용) */
export function sumProviderCounts(windows: Pick<AnalyticsWindow, "providerCounts">[]): Partial<Record<ChatProvider, number>> {
  const totals: Partial<Record<ChatProvider, number>> = {};
  for (const window of windows) {
    for (const provider of PROVIDER_ORDER) {
      const count = window.providerCounts[provider];
      if (count) {
        totals[provider] = (totals[provider] ?? 0) + count;
      }
    }
  }
  return totals;
}

/**
 * 이론상의 초 후보들 중 실제로 캡처된 프레임(availableSeconds)에 매칭되는 것만 남긴다.
 * ffmpeg가 끊겼다 재연결되며 생기는 캡처 공백 구간은 여기서 걸러져, 없는 프레임을 시도했다가
 * 화면이 껐다 켜졌다 하는 깜빡임을 만들지 않는다. 같은 실제 초로 중복 매칭되면 한 번만 남긴다.
 */
export function filterAvailableSeconds(
  candidateSeconds: number[],
  availableSeconds: number[],
  toleranceSec = FRAME_MATCH_TOLERANCE_SEC
): number[] {
  const resolved: number[] = [];
  const seen = new Set<number>();
  for (const target of candidateSeconds) {
    const match = nearestFrameSecond(availableSeconds, target, toleranceSec);
    if (match !== undefined && !seen.has(match)) {
      seen.add(match);
      resolved.push(match);
    }
  }
  return resolved;
}

/**
 * primary 플랫폼에 실제 캡처된 프레임이 있으면 그걸 쓰고, 하나도 없으면 fallback 플랫폼을 시도한다.
 * 채팅이 없던 구간(providerCounts가 비어 dominantProvider가 undefined인 경우)에도, 프레임 자체는
 * 채팅과 무관하게 계속 캡처되므로 실제로 존재하는 쪽을 찾아 보여줄 수 있다.
 */
export function resolveAvailableFrames(
  candidateSeconds: number[],
  framesByProvider: Partial<Record<ChatProvider, number[]>>,
  primary: ChatProvider,
  fallback: ChatProvider
): { provider: ChatProvider; seconds: number[] } {
  const primarySeconds = filterAvailableSeconds(candidateSeconds, framesByProvider[primary] ?? []);
  if (primarySeconds.length > 0) {
    return { provider: primary, seconds: primarySeconds };
  }
  const fallbackSeconds = filterAvailableSeconds(candidateSeconds, framesByProvider[fallback] ?? []);
  if (fallbackSeconds.length > 0) {
    return { provider: fallback, seconds: fallbackSeconds };
  }
  return { provider: primary, seconds: [] };
}
