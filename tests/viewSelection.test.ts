import { describe, expect, it } from "vitest";
import { LIVE_VIEW_ID, mergedViewId, parseViewSelection } from "../src/client/viewSelection";

describe("parseViewSelection", () => {
  it("'live'는 라이브 뷰", () => {
    expect(parseViewSelection(LIVE_VIEW_ID)).toEqual({ kind: "live" });
  });

  it("'<broadcastId>__merged'는 병합 뷰(broadcastId 추출)", () => {
    expect(parseViewSelection("20260720-153012-a1b2c3__merged")).toEqual({
      kind: "merged",
      broadcastId: "20260720-153012-a1b2c3"
    });
  });

  it("provider 세션 키는 세션 뷰(합성 키 원형 유지)", () => {
    expect(parseViewSelection("20260720-153012-a1b2c3__chzzk")).toEqual({
      kind: "session",
      sessionId: "20260720-153012-a1b2c3__chzzk"
    });
    expect(parseViewSelection("20260720-153012-a1b2c3__soop")).toEqual({
      kind: "session",
      sessionId: "20260720-153012-a1b2c3__soop"
    });
  });

  it("빈 broadcastId의 __merged는 병합으로 취급하지 않는다(세션 폴백)", () => {
    expect(parseViewSelection("__merged")).toEqual({ kind: "session", sessionId: "__merged" });
  });
});

describe("mergedViewId", () => {
  it("broadcastId에 __merged 접미사를 붙인다 (parseViewSelection 라운드트립)", () => {
    const id = mergedViewId("20260720-153012-a1b2c3");
    expect(id).toBe("20260720-153012-a1b2c3__merged");
    expect(parseViewSelection(id)).toEqual({ kind: "merged", broadcastId: "20260720-153012-a1b2c3" });
  });
});
