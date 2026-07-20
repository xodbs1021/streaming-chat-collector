import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { BroadcastTabs } from "../src/client/components/dashboard/BroadcastTabs";
import type { ChatProvider, RecordingSession } from "../src/shared/types";

function session(sessionId: string, provider: ChatProvider, messageCount = 0): RecordingSession {
  return { sessionId, provider, sourceMode: "unofficial", channelId: "ch", startedAt: 0, messageCount, fileName: `${sessionId}.jsonl` };
}

const sessions = [session("b1__chzzk", "chzzk", 10), session("b1__soop", "soop", 4)];

describe("BroadcastTabs", () => {
  it("selects a tab's session on click", () => {
    const onSelectSession = vi.fn();
    render(<BroadcastTabs sessions={sessions} selectedSessionId="b1__chzzk" onSelectSession={onSelectSession} />);

    fireEvent.click(screen.getByRole("tab", { name: /SOOP/ }));

    expect(onSelectSession).toHaveBeenCalledWith("b1__soop");
  });

  it("uses roving tabindex so only the selected tab is in the tab order", () => {
    render(<BroadcastTabs sessions={sessions} selectedSessionId="b1__chzzk" onSelectSession={vi.fn()} />);
    const [chzzkTab, soopTab] = screen.getAllByRole("tab");

    expect(chzzkTab).toHaveAttribute("tabindex", "0");
    expect(soopTab).toHaveAttribute("tabindex", "-1");
  });

  it("moves to the next sibling on ArrowRight", () => {
    const onSelectSession = vi.fn();
    render(<BroadcastTabs sessions={sessions} selectedSessionId="b1__chzzk" onSelectSession={onSelectSession} />);

    fireEvent.keyDown(screen.getByRole("tab", { name: /치지직/ }), { key: "ArrowRight" });

    expect(onSelectSession).toHaveBeenCalledWith("b1__soop");
  });

  it("wraps to the first sibling on ArrowRight from the last tab", () => {
    const onSelectSession = vi.fn();
    render(<BroadcastTabs sessions={sessions} selectedSessionId="b1__soop" onSelectSession={onSelectSession} />);

    fireEvent.keyDown(screen.getByRole("tab", { name: /SOOP/ }), { key: "ArrowRight" });

    expect(onSelectSession).toHaveBeenCalledWith("b1__chzzk");
  });

  it("moves to the previous sibling on ArrowLeft", () => {
    const onSelectSession = vi.fn();
    render(<BroadcastTabs sessions={sessions} selectedSessionId="b1__soop" onSelectSession={onSelectSession} />);

    fireEvent.keyDown(screen.getByRole("tab", { name: /SOOP/ }), { key: "ArrowLeft" });

    expect(onSelectSession).toHaveBeenCalledWith("b1__chzzk");
  });
});
