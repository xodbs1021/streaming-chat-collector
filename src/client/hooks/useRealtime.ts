import { useEffect, useMemo, useState } from "react";
import { defaultSettings } from "../../shared/settings";
import type { ChatMessage, OverlaySettings, ProviderStatus, ProviderStatusMap } from "../../shared/types";
import { socket } from "../socket";

const initialStatus: ProviderStatus = {
  provider: "chzzk",
  sourceMode: "official",
  state: "idle",
  message: "채팅 소스 연결 대기 중"
};

const initialStatuses: ProviderStatusMap = {
  chzzk: initialStatus,
  soop: {
    provider: "soop",
    sourceMode: "unofficial",
    state: "idle",
    message: "SOOP 연결 대기 중"
  }
};

export function useRealtime() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [settings, setSettings] = useState<OverlaySettings>(defaultSettings);
  const [providerStatus, setProviderStatus] = useState<ProviderStatus>(initialStatus);
  const [providerStatuses, setProviderStatuses] = useState<ProviderStatusMap>(initialStatuses);
  const [socketConnected, setSocketConnected] = useState(socket.connected);

  useEffect(() => {
    const onConnect = () => setSocketConnected(true);
    const onDisconnect = () => setSocketConnected(false);
    const onHistory = (history: ChatMessage[]) => setMessages(history);
    const onMessage = (message: ChatMessage) => {
      setMessages((current) => [...current, message].slice(-settings.maxMessages));
    };
    const onDelete = (messageId: string) => {
      setMessages((current) => current.filter((message) => message.messageId !== messageId));
    };
    const onProviderStatus = (status: ProviderStatus) => {
      setProviderStatus(status);
      setProviderStatuses((current) => ({ ...current, [status.provider]: status }));
    };
    const onProviderStatuses = (statuses: ProviderStatusMap) => {
      setProviderStatuses((current) => ({ ...current, ...statuses }));
      setProviderStatus((current) => statuses[current.provider] ?? firstKnownStatus(statuses) ?? current);
    };

    socket.on("connect", onConnect);
    socket.on("disconnect", onDisconnect);
    socket.on("chat:history", onHistory);
    socket.on("chat:message", onMessage);
    socket.on("chat:delete", onDelete);
    socket.on("settings:update", setSettings);
    socket.on("provider:status", onProviderStatus);
    socket.on("provider:statuses", onProviderStatuses);

    return () => {
      socket.off("connect", onConnect);
      socket.off("disconnect", onDisconnect);
      socket.off("chat:history", onHistory);
      socket.off("chat:message", onMessage);
      socket.off("chat:delete", onDelete);
      socket.off("settings:update", setSettings);
      socket.off("provider:status", onProviderStatus);
      socket.off("provider:statuses", onProviderStatuses);
    };
  }, [settings.maxMessages]);

  return useMemo(
    () => ({ messages, settings, providerStatus, providerStatuses, socketConnected, socket }),
    [messages, settings, providerStatus, providerStatuses, socketConnected]
  );
}

function firstKnownStatus(statuses: ProviderStatusMap) {
  return Object.values(statuses).find((status): status is ProviderStatus => Boolean(status));
}
