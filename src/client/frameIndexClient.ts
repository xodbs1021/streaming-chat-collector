import type { ChatProvider, FrameIndexResponse } from "../shared/types";
import type { FrameCaptureStatus } from "../shared/frameCaptureStatus";

/** 프레임 API 주소의 공통 앞부분 — broadcastId를 주면 과거 방송 주소, 없으면 라이브 주소(현행). */
function frameApiBase(provider: ChatProvider, broadcastId?: string): string {
  return broadcastId ? `/api/broadcasts/${encodeURIComponent(broadcastId)}/frames/${provider}` : `/api/frames/${provider}`;
}

/** 서버가 실제로 캡처해둔 프레임 초 목록을 가져온다 (정렬 보장). broadcastId를 주면 과거 방송을 읽는다. */
export async function fetchFrameSeconds(
  provider: ChatProvider,
  fromSec: number,
  toSec: number,
  broadcastId?: string
): Promise<number[]> {
  const params = new URLSearchParams({ from: String(Math.floor(fromSec)), to: String(Math.ceil(toSec)) });
  const response = await fetch(`${frameApiBase(provider, broadcastId)}/index?${params.toString()}`);
  if (!response.ok) {
    return [];
  }
  // 서버 계약은 FrameIndexResponse — 다만 경계면이므로 shape을 신뢰하지 않고 런타임 검증(Array/number 필터)은 유지한다.
  const json = (await response.json()) as Partial<FrameIndexResponse>;
  const seconds = Array.isArray(json.seconds) ? json.seconds.filter((value): value is number => typeof value === "number") : [];
  return seconds.slice().sort((left, right) => left - right);
}

/** 프레임 이미지 주소 조립의 단일 지점. broadcastId 있으면 과거 방송 주소. */
export function frameImageUrl(provider: ChatProvider, second: number, broadcastId?: string): string {
  return `${frameApiBase(provider, broadcastId)}/${second}.jpg`;
}

/** 서버가 정규화한 캡처 상태를 가져온다 (404/네트워크 오류 시 undefined — 폴링 격리) */
export async function fetchFrameCaptureStatus(provider: ChatProvider): Promise<FrameCaptureStatus | undefined> {
  try {
    const response = await fetch(`/api/frames/${provider}/status`);
    if (!response.ok) {
      return undefined;
    }
    const json = (await response.json()) as { capture?: FrameCaptureStatus };
    return json.capture;
  } catch {
    return undefined;
  }
}
