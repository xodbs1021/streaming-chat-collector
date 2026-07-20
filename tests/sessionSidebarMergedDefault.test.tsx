import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SessionSidebar } from "../src/client/components/dashboard/SessionSidebar";
import { groupSessionsByBroadcast } from "../src/client/components/dashboard/broadcastGroups";
import type { ChatProvider, RecordingSession } from "../src/shared/types";

function session(broadcastId: string, provider: ChatProvider, messageCount: number): RecordingSession {
  return {
    sessionId: `${broadcastId}__${provider}`,
    broadcastId,
    provider,
    sourceMode: "unofficial",
    channelId: "ch",
    startedAt: 1000,
    messageCount,
    fileName: "chat.jsonl"
  };
}

function renderSidebar(selectedSessionId: string, onSelectSession = vi.fn()) {
  const sessions = [session("b1", "chzzk", 10), session("b1", "soop", 4)];
  const groups = groupSessionsByBroadcast(sessions);
  render(
    <SessionSidebar
      dateFilter=""
      displayNameDraft=""
      liveTotalMessages={0}
      providerFilter="all"
      selectedSessionId={selectedSessionId}
      visibleGroups={groups}
      onDateChange={vi.fn()}
      onDisplayNameChange={vi.fn()}
      onProviderChange={vi.fn()}
      onSaveDisplayName={vi.fn()}
      onSelectSession={onSelectSession}
    />
  );
  return onSelectSession;
}

describe("SessionSidebar 병합 기본 선택", () => {
  it("provider가 2개인 방송 행을 클릭하면 합쳐 보기(merged)를 기본 선택한다", () => {
    const onSelectSession = renderSidebar("live");

    // 방송 행은 provider 배지(치지직/SOOP)를 가진 버튼 — 실시간 행("실시간")과 구분된다.
    fireEvent.click(screen.getByRole("button", { name: /치지직.*SOOP/ }));

    expect(onSelectSession).toHaveBeenCalledWith("b1__merged");
  });

  it("그 방송의 병합 뷰를 보고 있으면 방송 행이 활성 표시된다", () => {
    renderSidebar("b1__merged");
    const activeRow = document.querySelector(".session-row.active");
    expect(activeRow?.textContent).toMatch(/치지직/);
  });
});
