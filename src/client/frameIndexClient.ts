import type { ChatProvider } from "../shared/types";
import type { FrameCaptureStatus } from "../shared/frameCaptureStatus";

/** 서버가 실제로 캡처해둔 프레임 초 목록을 가져온다 (정렬 보장) */
export async function fetchFrameSeconds(provider: ChatProvider, fromSec: number, toSec: number): Promise<number[]> {
  const params = new URLSearchParams({ from: String(Math.floor(fromSec)), to: String(Math.ceil(toSec)) });
  const response = await fetch(`/api/frames/${provider}/index?${params.toString()}`);
  if (!response.ok) {
    return [];
  }
  const json = (await response.json()) as { seconds?: unknown };
  const seconds = Array.isArray(json.seconds) ? json.seconds.filter((value): value is number => typeof value === "number") : [];
  return seconds.slice().sort((left, right) => left - right);
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
