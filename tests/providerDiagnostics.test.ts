import { describe, expect, it } from "vitest";
import { classifyProviderFailureReason } from "../src/server/providerDiagnostics";

describe("provider diagnostics", () => {
  it("classifies common provider failure messages", () => {
    expect(classifyProviderFailureReason("SOOP BJ ID 또는 방송 URL을 입력해주세요.")).toBe("input_error");
    expect(classifyProviderFailureReason("현재 SOOP 공개 채팅 정보를 찾지 못했습니다.")).toBe("offline");
    expect(classifyProviderFailureReason("이 방송은 게스트 채팅을 허용하지 않습니다.")).toBe("guest_chat_blocked");
    expect(classifyProviderFailureReason("chat-1.sooplive.com:8001 WebSocket 오류")).toBe("network_blocked");
    expect(classifyProviderFailureReason("앱 업데이트 후에 정상 시청 가능합니다.")).toBe("protocol_changed");
    expect(classifyProviderFailureReason("치지직 토큰 발급 실패")).toBe("auth_required");
  });
});
