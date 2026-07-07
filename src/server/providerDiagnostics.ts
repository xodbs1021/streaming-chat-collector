import type { ProviderFailureReason } from "../shared/types";

export function classifyProviderFailureReason(message: string): ProviderFailureReason {
  const normalized = message.toLowerCase();
  if (message.includes("BJ ID") || message.includes("채널 ID") || message.includes("URL") || message.includes("입력")) {
    return "input_error";
  }
  if (message.includes("오프라인") || message.includes("정보를 찾지 못") || message.includes("라이브 정보")) {
    return "offline";
  }
  if (message.includes("게스트") || message.includes("로그인이 필요")) {
    return "guest_chat_blocked";
  }
  if (message.includes("네트워크") || message.includes("포트") || normalized.includes("websocket")) {
    return "network_blocked";
  }
  if (message.includes("프로토콜") || message.includes("앱 업데이트") || message.includes("unsupported")) {
    return "protocol_changed";
  }
  if (message.includes("OAuth") || message.includes("토큰") || message.includes("로그인")) {
    return "auth_required";
  }
  return "unknown";
}
