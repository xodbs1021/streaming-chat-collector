import { randomUUID } from "node:crypto";
import type { Server } from "socket.io";
import { defaultSettings, normalizeSettings } from "../shared/settings";
import type {
  ChatProvider,
  ChatMessage,
  ClientToServerEvents,
  OverlaySettings,
  ProviderStatusMap,
  ProviderStatus,
  ServerToClientEvents
} from "../shared/types";

export type AppSocketServer = Server<ClientToServerEvents, ServerToClientEvents>;

export interface AppStateHooks {
  onMessage?(message: ChatMessage): void;
}

export class AppState {
  private settings: OverlaySettings = defaultSettings;
  private messages: ChatMessage[] = [];
  private statuses: ProviderStatusMap = {
    chzzk: {
      provider: "chzzk",
      sourceMode: "official",
      state: "idle",
      message: "치지직 연결 대기 중"
    },
    soop: {
      provider: "soop",
      sourceMode: "unofficial",
      state: "idle",
      message: "SOOP 연결 대기 중"
    }
  };
  private lastStatusProvider: ChatProvider = "chzzk";
  private addedAt = new Map<string, number>();

  constructor(
    private readonly io: AppSocketServer,
    private readonly hooks: AppStateHooks = {}
  ) {
    const sweepTimer = setInterval(() => this.sweepExpiredMessages(), 1_000);
    (sweepTimer as { unref?: () => void }).unref?.();
  }

  getSettings() {
    return this.settings;
  }

  updateSettings(patch: Partial<OverlaySettings>) {
    this.settings = normalizeSettings({ ...this.settings, ...patch });
    this.trimMessages();
    this.io.emit("settings:update", this.settings);
    this.io.emit("chat:history", this.messages);
    return this.settings;
  }

  getMessages() {
    return this.messages;
  }

  addMessage(message: ChatMessage) {
    this.messages.push(message);
    this.addedAt.set(message.messageId, Date.now());
    this.trimMessages();
    this.io.emit("chat:message", message);
    this.hooks.onMessage?.(message);
  }

  addTestMessage(input?: string | { content?: string; provider?: ChatProvider }) {
    const content = typeof input === "string" ? input : input?.content;
    const provider = typeof input === "string" ? this.getStatus().provider : input?.provider ?? this.getStatus().provider;
    const message: ChatMessage = {
      provider,
      sourceMode: "mock",
      channelId: "local-test",
      messageId: `test-${randomUUID()}`,
      nickname: randomNickname(),
      role: "viewer",
      badges: [{ id: "test", label: "TEST" }],
      content: content?.trim() || randomContent(),
      emotes: [],
      timestamp: Date.now(),
      raw: { test: true }
    };
    this.addMessage(message);
    return message;
  }

  getStatus(provider?: ChatProvider) {
    if (provider) {
      return this.statuses[provider] ?? buildIdleStatus(provider);
    }
    return this.statuses[this.lastStatusProvider] ?? this.statuses.chzzk ?? buildIdleStatus("chzzk");
  }

  getStatuses() {
    return { ...this.statuses };
  }

  setStatus(status: ProviderStatus) {
    this.lastStatusProvider = status.provider;
    this.statuses = {
      ...this.statuses,
      [status.provider]: status
    };
    this.io.emit("provider:status", status);
    this.io.emit("provider:statuses", this.getStatuses());
  }

  hydrateSocket(socketId: string) {
    const socket = this.io.sockets.sockets.get(socketId);
    if (!socket) {
      return;
    }
    socket.emit("settings:update", this.settings);
    socket.emit("provider:status", this.getStatus());
    socket.emit("provider:statuses", this.getStatuses());
    socket.emit("chat:history", this.messages);
  }

  private trimMessages() {
    if (this.messages.length > this.settings.maxMessages) {
      const removed = this.messages.slice(0, this.messages.length - this.settings.maxMessages);
      this.messages = this.messages.slice(-this.settings.maxMessages);
      for (const message of removed) {
        this.addedAt.delete(message.messageId);
      }
    }
  }

  private sweepExpiredMessages() {
    const lifetimeMs = this.settings.messageLifetimeSec * 1000;
    if (lifetimeMs <= 0 || this.messages.length === 0) {
      return;
    }
    const now = Date.now();
    const expiredIds: string[] = [];
    for (const message of this.messages) {
      const addedAt = this.addedAt.get(message.messageId);
      if (addedAt === undefined) {
        this.addedAt.set(message.messageId, now);
        continue;
      }
      if (now - addedAt >= lifetimeMs) {
        expiredIds.push(message.messageId);
      }
    }
    if (expiredIds.length === 0) {
      return;
    }
    const expired = new Set(expiredIds);
    this.messages = this.messages.filter((message) => !expired.has(message.messageId));
    for (const messageId of expiredIds) {
      this.addedAt.delete(messageId);
      this.io.emit("chat:delete", messageId);
    }
  }
}

function buildIdleStatus(provider: ChatProvider): ProviderStatus {
  return {
    provider,
    sourceMode: provider === "soop" ? "unofficial" : "official",
    state: "idle",
    message: provider === "soop" ? "SOOP 연결 대기 중" : "치지직 연결 대기 중"
  };
}

function randomNickname() {
  const names = ["초록별", "방송친구", "채팅요정", "나이스샷", "집중모드", "첫줄장인"];
  return names[Math.floor(Math.random() * names.length)];
}

function randomContent() {
  const messages = [
    "오늘 화면 깔끔하다!",
    "채팅 연결 테스트 메시지입니다.",
    "OBS 오버레이 잘 보이는지 확인 중",
    "긴 메시지도 잘 줄바꿈 되는지 확인해보는 테스트 채팅입니다. 폰트와 카드 폭을 봐주세요.",
    "ㅋㅋㅋㅋㅋ"
  ];
  return messages[Math.floor(Math.random() * messages.length)];
}
