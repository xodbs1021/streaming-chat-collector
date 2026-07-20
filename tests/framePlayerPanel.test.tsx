import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup } from "@testing-library/react";
import { FramePlayerPanel } from "../src/client/components/dashboard/FramePlayerPanel";
import type { AnalyticsWindow } from "../src/shared/types";

afterEach(cleanup);

/** 채팅이 하나도 없던(providerCounts 비어 있음) 세션 구간 윈도우 */
function emptyChatWindow(windowStart: number, windowEnd: number): AnalyticsWindow {
  return {
    windowStart,
    windowEnd,
    messageCount: 0,
    uniqueChatters: 0,
    avgLength: 0,
    maxLength: 0,
    providerCounts: {},
    roleCounts: {},
    topChatters: [],
    topTerms: [],
    topEmotes: []
  };
}

describe("FramePlayerPanel · 빈 구간 프레임 폴백", () => {
  it("SOOP 세션 탭의 채팅 없는 구간에서 SOOP 프레임을 보여준다(치지직 하드코딩 회귀 방지)", () => {
    const { container } = render(
      <FramePlayerPanel
        range={{ startAt: 10_000, endAt: 15_000 }}
        windows={[emptyChatWindow(10_000, 15_000)]}
        frameSecondsByProvider={{}}
        frameIndexLoaded={false}
        sessionProvider="soop"
      />
    );

    // SOOP 탭이 활성, 치지직 탭은 비활성이어야 한다.
    expect(screen.getByRole("tab", { name: "SOOP" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tab", { name: "치지직" })).toHaveAttribute("aria-selected", "false");

    // 렌더된 프레임 이미지 주소도 soop 경로여야 한다(치지직 아님).
    const frame = container.querySelector("img.frame-preview");
    expect(frame).not.toBeNull();
    expect(frame?.getAttribute("src")).toContain("/api/frames/soop/");
  });

  it("라이브(병합) 뷰의 빈 구간에서는 sessionProvider가 없어 치지직 폴백을 유지한다(라이브 동작 보존)", () => {
    const { container } = render(
      <FramePlayerPanel
        range={{ startAt: 10_000, endAt: 15_000 }}
        windows={[emptyChatWindow(10_000, 15_000)]}
        frameSecondsByProvider={{}}
        frameIndexLoaded={false}
        // sessionProvider 미주입(undefined) = 라이브 병합 뷰 — SOOP 케이스의 거울상.
      />
    );

    // 세션 provider가 없으니 기존 dominant→chzzk 폴백대로 치지직 탭이 활성이어야 한다.
    expect(screen.getByRole("tab", { name: "치지직" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tab", { name: "SOOP" })).toHaveAttribute("aria-selected", "false");

    const frame = container.querySelector("img.frame-preview");
    expect(frame).not.toBeNull();
    expect(frame?.getAttribute("src")).toContain("/api/frames/chzzk/");
  });
});
