import type { ChatProvider } from "../shared/types";
import { parseChzzkChannelInput } from "./providers/chzzkUnofficial";
import { parseSoopChannelInput } from "./providers/soopUnofficial";

// 캡처 채널 해석은 채팅 어댑터와 같은 파서를 써야 한다 — 입력창에는 채널 ID뿐 아니라
// 라이브 URL(https://chzzk.naver.com/live/...)도 들어오는데, 어댑터만 정규화하고 캡처가
// 원문을 받으면 HLS 조회가 URL 문자열로 나가 영원히 실패한다 (2026-07-12 실사고, PR #20 회귀).
export function resolveFrameChannelInput(provider: ChatProvider, rawInput: string): string | undefined {
  const value = rawInput.trim();
  if (!value) {
    return undefined;
  }
  if (provider === "chzzk") {
    return parseChzzkChannelInput(value)?.channelId;
  }
  return parseSoopChannelInput(value)?.bjId;
}
