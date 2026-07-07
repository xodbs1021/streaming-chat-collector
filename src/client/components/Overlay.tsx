import { useEffect, useRef } from "react";
import type { CSSProperties } from "react";
import type { ChatMessage, OverlaySettings, ProviderStatus, ProviderStatusMap } from "../../shared/types";
import { useRealtime } from "../hooks/useRealtime";

export function OverlayRoute() {
  const { messages, settings, providerStatus, providerStatuses, socketConnected } = useRealtime();
  return (
    <main className="overlay-shell" style={{ "--chat-font-size": `${settings.fontSize}px` } as CSSProperties}>
      <div className="overlay-stack" data-testid="overlay-stack">
        <ConnectionPill status={providerStatus} statuses={providerStatuses} socketConnected={socketConnected} />
        <ChatList messages={messages} settings={settings} />
      </div>
    </main>
  );
}

function ConnectionPill({
  status,
  statuses,
  socketConnected
}: {
  status: ProviderStatus;
  statuses: ProviderStatusMap;
  socketConnected: boolean;
}) {
  const connected = Object.values(statuses).filter((item): item is ProviderStatus => Boolean(item && item.state === "connected"));
  const healthy = socketConnected && connected.length > 0;
  const label = connected.map((item) => `${getProviderLabel(item.provider)} LIVE`).join(" · ");
  return (
    <div className={`connection-pill ${healthy ? "is-live" : ""}`} aria-live="polite">
      <span className="status-dot" />
      <span>{!socketConnected ? "서버 연결이 끊겼습니다." : healthy ? label : status.message}</span>
    </div>
  );
}

function ChatList({ messages, settings }: { messages: ChatMessage[]; settings: OverlaySettings }) {
  const listRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: "smooth" });
  }, [messages]);

  return (
    <div className="chat-list" ref={listRef} aria-label="방송 채팅 목록">
      {messages.map((message) => (
        <ChatRow key={message.messageId} message={message} settings={settings} />
      ))}
    </div>
  );
}

function ChatRow({ message, settings }: { message: ChatMessage; settings: OverlaySettings }) {
  const style = {
    "--message-bg": `rgba(10, 18, 16, ${settings.backgroundOpacity})`
  } as CSSProperties;

  return (
    <article className={`chat-row ${settings.compactMode ? "is-compact" : ""}`} style={style}>
      {settings.showSourceLabel && (
        <span className={`source-label source-${message.provider} source-${message.sourceMode}`}>
          {getProviderLabel(message.provider)}
        </span>
      )}
      <div className="message-line">
        {settings.showBadges && (
          <span className="badge-list" aria-label="배지">
            {message.badges.map((badge) =>
              badge.imageUrl ? (
                <img className="badge-image" key={badge.id} src={badge.imageUrl} alt={badge.label} />
              ) : (
                <span className="badge-chip" key={badge.id}>
                  {badge.label}
                </span>
              )
            )}
          </span>
        )}
        <span className={`nickname role-${message.role}`}>{message.nickname}</span>
        {settings.showTimestamps && <time>{formatTime(message.timestamp)}</time>}
        <span className="content">{renderContentWithEmotes(message)}</span>
      </div>
    </article>
  );
}

function getProviderLabel(provider: ChatMessage["provider"]) {
  return provider === "soop" ? "SOOP" : "CHZZK";
}

function renderContentWithEmotes(message: ChatMessage) {
  if (message.emotes.length === 0) {
    return message.content;
  }

  const emotes = new Map(message.emotes.map((emote) => [emote.token, emote]));
  const parts = message.content.split(/(\{:[^}]+:\}|:[\w-]+:)/g);

  return parts.map((part, index) => {
    const emote = emotes.get(part);
    if (!emote) {
      return <span key={`${part}-${index}`}>{part}</span>;
    }
    return <img className="inline-emote" key={`${emote.id}-${index}`} src={emote.url} alt={emote.token} />;
  });
}

function formatTime(timestamp: number) {
  return new Intl.DateTimeFormat("ko-KR", {
    hour: "2-digit",
    minute: "2-digit"
  }).format(timestamp);
}
