import { describe, expect, it } from "vitest";
import { parseChzzkTokenResponse } from "../src/server/providers/chzzkToken";

describe("chzzk token parsing", () => {
  it("parses wrapped token responses", () => {
    const token = parseChzzkTokenResponse({
      content: {
        accessToken: "access",
        refreshToken: "refresh",
        tokenType: "Bearer",
        expiresIn: 10,
        scope: "채팅 메시지 조회"
      }
    });

    expect(token).toMatchObject({
      accessToken: "access",
      refreshToken: "refresh",
      tokenType: "Bearer",
      scope: "채팅 메시지 조회"
    });
  });

  it("parses direct token responses", () => {
    const token = parseChzzkTokenResponse({
      accessToken: "access",
      expiresIn: "20"
    }, "old-refresh");

    expect(token).toMatchObject({
      accessToken: "access",
      refreshToken: "old-refresh",
      tokenType: "Bearer"
    });
  });
});
