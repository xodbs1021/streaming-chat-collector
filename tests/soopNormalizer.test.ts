import { describe, expect, it } from "vitest";
import { normalizeSoopChatPacket, parseSoopPacket, SOOP_SERVICE } from "../src/server/providers/soopNormalizer";

describe("soop chat normalization", () => {
  it("parses binary SOOP packets", () => {
    const packet = parseSoopPacket(makePacket(SOOP_SERVICE.CHAT_MESSAGE, ["안녕하세요", "user-1", "0", "0", "3", "소프유저", "16"]));

    expect(packet).toMatchObject({
      serviceCode: SOOP_SERVICE.CHAT_MESSAGE,
      retCode: 0,
      packet: ["안녕하세요", "user-1", "0", "0", "3", "소프유저", "16"]
    });
  });

  it("normalizes chat messages with sender and badges", () => {
    const packet = parseSoopPacket(
      makePacket(SOOP_SERVICE.CHAT_MESSAGE, ["좋아요", "user-2", "0", "0", "3", "매니저닉", "256", "12"])
    );

    expect(packet).toBeDefined();
    const message = normalizeSoopChatPacket(packet!, "bj-1");

    expect(message).toMatchObject({
      provider: "soop",
      sourceMode: "unofficial",
      channelId: "bj-1",
      nickname: "매니저닉",
      role: "manager",
      content: "좋아요"
    });
    expect(message?.badges).toEqual(
      expect.arrayContaining([
        { id: "soop-manager", label: "매니저" },
        { id: "soop-subscription", label: "12개월" }
      ])
    );
  });

  it("keeps long SOOP messages intact", () => {
    const content = "숲".repeat(240);
    const packet = parseSoopPacket(makePacket(SOOP_SERVICE.CHAT_MESSAGE, [content, "user-3", "0", "0", "3", "긴닉네임", "0"]));
    const message = normalizeSoopChatPacket(packet!, "bj-1");

    expect(message?.content).toHaveLength(240);
  });

  it("does not normalize non-chat service packets", () => {
    const packet = parseSoopPacket(makePacket(SOOP_SERVICE.JOIN_CHANNEL, ["1819", "bj-1"]));
    expect(normalizeSoopChatPacket(packet!, "bj-1")).toBeUndefined();
  });
});

function makePacket(serviceCode: number, fields: string[], retCode = 0) {
  const sep = Uint8Array.from([12]);
  const body = concat([sep, ...fields.flatMap((field) => [new TextEncoder().encode(field), sep])]);
  const header = Uint8Array.from(
    Array.from(`\u001b\t${String(serviceCode).padStart(4, "0")}${String(body.byteLength).padStart(6, "0")}${String(retCode).padStart(2, "0")}`),
    (char) => char.charCodeAt(0)
  );
  return concat([header, body]);
}

function concat(parts: Uint8Array[]) {
  const length = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.byteLength;
  }
  return bytes;
}
