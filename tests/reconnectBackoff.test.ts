import { describe, expect, it } from "vitest";
import { computeReconnectDelayMs } from "../src/server/providers/reconnectBackoff";

describe("reconnect backoff", () => {
  it("doubles the delay with each attempt", () => {
    expect(computeReconnectDelayMs(1)).toBe(2_000);
    expect(computeReconnectDelayMs(2)).toBe(4_000);
    expect(computeReconnectDelayMs(3)).toBe(8_000);
    expect(computeReconnectDelayMs(4)).toBe(16_000);
  });

  it("caps the delay at 30 seconds", () => {
    expect(computeReconnectDelayMs(5)).toBe(30_000);
    expect(computeReconnectDelayMs(10)).toBe(30_000);
  });

  it("treats non-positive attempts as attempt 1", () => {
    expect(computeReconnectDelayMs(0)).toBe(2_000);
    expect(computeReconnectDelayMs(-3)).toBe(2_000);
  });
});
