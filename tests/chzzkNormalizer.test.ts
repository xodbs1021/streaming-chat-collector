import { describe, expect, it } from "vitest";
import {
  normalizeOfficialChzzkChatEvent,
  normalizeUnofficialChzzkChatEvent
} from "../src/server/providers/chzzkNormalizer";

describe("chzzk chat normalization", () => {
  it("normalizes official CHAT events", () => {
    const message = normalizeOfficialChzzkChatEvent({
      channelId: "channel-1",
      senderChannelId: "sender-1",
      profile: {
        nickname: "테스터",
        verifiedMark: true,
        userRoleCode: "streaming_chat_manager",
        badges: [{ id: "manager", label: "매니저" }]
      },
      content: "안녕 :smile:",
      emojis: { ":smile:": "https://example.com/smile.png" },
      messageTime: 1_720_000_000_000
    });

    expect(message.provider).toBe("chzzk");
    expect(message.sourceMode).toBe("official");
    expect(message.nickname).toBe("테스터");
    expect(message.role).toBe("chat_manager");
    expect(message.badges).toEqual(
      expect.arrayContaining([
        { id: "verified", label: "인증" },
        { id: "manager", label: "매니저", imageUrl: undefined }
      ])
    );
    expect(message.emotes).toEqual([{ id: ":smile:", token: ":smile:", url: "https://example.com/smile.png" }]);
  });

  it("normalizes unofficial packets with JSON profile strings", () => {
    const message = normalizeUnofficialChzzkChatEvent(
      {
        cid: "chat-channel",
        uid: "uid-1",
        profile: JSON.stringify({ nickname: "공개유저", userRoleCode: "common_user" }),
        extras: JSON.stringify({ emojis: { "{:gg:}": "https://example.com/gg.png" } }),
        msg: "좋아요 {:gg:}",
        msgTime: 1_720_000_000_100
      },
      "fallback-channel"
    );

    expect(message.sourceMode).toBe("unofficial");
    expect(message.channelId).toBe("chat-channel");
    expect(message.nickname).toBe("공개유저");
    expect(message.role).toBe("viewer");
    expect(message.emotes[0]).toMatchObject({ token: "{:gg:}" });
  });

  it("keeps long messages intact for overlay wrapping", () => {
    const content = "아".repeat(300);
    const message = normalizeOfficialChzzkChatEvent({ content });
    expect(message.content).toHaveLength(300);
  });
});
