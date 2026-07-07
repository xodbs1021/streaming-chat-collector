import { describe, expect, it } from "vitest";
import { buildEndpoints, deriveChatHosts, parseSoopChannelInput } from "../src/server/providers/soopUnofficial";

describe("soop unofficial adapter input parsing", () => {
  it("accepts plain BJ ids", () => {
    expect(parseSoopChannelInput("phonics1")).toEqual({ bjId: "phonics1" });
    expect(parseSoopChannelInput("@phonics1")).toEqual({ bjId: "phonics1" });
  });

  it("accepts current Korean SOOP play URLs", () => {
    expect(parseSoopChannelInput("https://play.sooplive.co.kr/phonics1")).toEqual({ bjId: "phonics1", broadNo: undefined });
    expect(parseSoopChannelInput("play.sooplive.co.kr/phonics1/123456789")).toEqual({
      bjId: "phonics1",
      broadNo: "123456789"
    });
  });

  it("keeps compatibility with global SOOP and old AfreecaTV URLs", () => {
    expect(parseSoopChannelInput("https://play.sooplive.com/phonics1")).toEqual({ bjId: "phonics1", broadNo: undefined });
    expect(parseSoopChannelInput("https://play.afreecatv.com/phonics1/123456789")).toEqual({
      bjId: "phonics1",
      broadNo: "123456789"
    });
  });

  it("supports channel pages and query-based URLs", () => {
    expect(parseSoopChannelInput("https://ch.sooplive.co.kr/phonics1")).toEqual({ bjId: "phonics1", broadNo: undefined });
    expect(parseSoopChannelInput("https://www.sooplive.co.kr/station/phonics1")).toEqual({
      bjId: "phonics1",
      broadNo: undefined
    });
    expect(parseSoopChannelInput("https://live.sooplive.co.kr/app/index.cgi?bjid=phonics1&bno=123456789")).toEqual({
      bjId: "phonics1",
      broadNo: "123456789"
    });
  });

  it("rejects unsupported URLs", () => {
    expect(parseSoopChannelInput("https://example.com/phonics1")).toBeUndefined();
    expect(parseSoopChannelInput("https://notsooplive.co.kr/phonics1")).toBeUndefined();
  });

  it("builds Korean SOOP websocket domains before global fallbacks", () => {
    const endpoints = buildEndpoints({
      bjId: "phonics1",
      chatNo: "1819",
      fanTicket: "ticket",
      chatHosts: ["chat-76DBFCD3.sooplive.co.kr", "chat-76DBFCD3.sooplive.com", "118.219.252.211"],
      chatPort: 8000
    });

    expect(endpoints[0]).toEqual({
      url: "wss://chat-76DBFCD3.sooplive.co.kr:8001/Websocket/phonics1",
      label: "chat-76DBFCD3.sooplive.co.kr:8001"
    });
    expect(endpoints[1]?.url).toBe("wss://chat-76DBFCD3.sooplive.com:8001/Websocket/phonics1");
    expect(endpoints.some((endpoint) => endpoint.url.startsWith("wss://118.219.252.211"))).toBe(false);
    expect(endpoints).toContainEqual({
      url: "ws://118.219.252.211:8000/Websocket/phonics1",
      label: "118.219.252.211:8000"
    });
  });

  it("derives Korean chat domains from global domains and raw IPs", () => {
    expect(deriveChatHosts({ CHDOMAIN: "chat-76DBFCD3.sooplive.com", CHIP: "118.219.252.211" })).toEqual([
      "chat-76DBFCD3.sooplive.co.kr",
      "chat-76DBFCD3.sooplive.com",
      "118.219.252.211"
    ]);
  });
});
