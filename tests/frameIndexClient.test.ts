import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchFrameSeconds, frameImageUrl } from "../src/client/frameIndexClient";

describe("frameIndexClient", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("frameImageUrl: broadcastId 없으면 라이브 주소", () => {
    expect(frameImageUrl("chzzk", 100)).toBe("/api/frames/chzzk/100.jpg");
  });

  it("frameImageUrl: broadcastId 있으면 과거 방송 주소(인코딩 포함)", () => {
    expect(frameImageUrl("chzzk", 100, "20260714-153012-a1b2c3")).toBe(
      "/api/broadcasts/20260714-153012-a1b2c3/frames/chzzk/100.jpg"
    );
    // 정상 형식엔 존재할 수 없는 문자지만, URL 조립 단일 지점의 인코딩 계약을 고정한다.
    expect(frameImageUrl("chzzk", 100, "a/b")).toBe("/api/broadcasts/a%2Fb/frames/chzzk/100.jpg");
  });

  it("fetchFrameSeconds: broadcastId 유무에 따라 주소를 고르고 from/to 쿼리를 유지한다", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ seconds: [5] }) });
    vi.stubGlobal("fetch", fetchMock);

    await fetchFrameSeconds("chzzk", 10.2, 20.7);
    expect(fetchMock).toHaveBeenLastCalledWith("/api/frames/chzzk/index?from=10&to=21");

    await fetchFrameSeconds("soop", 10.2, 20.7, "20260714-153012-a1b2c3");
    expect(fetchMock).toHaveBeenLastCalledWith("/api/broadcasts/20260714-153012-a1b2c3/frames/soop/index?from=10&to=21");
  });

  it("fetchFrameSeconds: 비정상 응답은 []이고 숫자만 필터·정렬한다", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false }));
    expect(await fetchFrameSeconds("chzzk", 0, 10)).toEqual([]);

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, json: async () => ({ seconds: [3, "x", 1, null, 2] }) })
    );
    expect(await fetchFrameSeconds("chzzk", 0, 10)).toEqual([1, 2, 3]);
  });
});
