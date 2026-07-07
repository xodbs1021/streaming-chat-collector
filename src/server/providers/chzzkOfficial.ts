import ioV2 from "socket.io-client-v2";
import { CHZZK_OPEN_API_BASE, type AppConfig } from "../config";
import { normalizeOfficialChzzkChatEvent } from "./chzzkNormalizer";
import { fetchChzzkViewerCount } from "./chzzkUnofficial";
import { computeReconnectDelayMs } from "./reconnectBackoff";
import { parseChzzkTokenResponse } from "./chzzkToken";
import type { ChzzkTokenSet, ProviderAdapter, ProviderCallbacks } from "./types";
import type { ProviderStatus } from "../../shared/types";

interface ChzzkSessionResponse {
  code: number;
  message: string | null;
  content?: {
    url?: string;
  };
}

export class ChzzkOfficialAdapter implements ProviderAdapter {
  readonly provider = "chzzk" as const;
  readonly sourceMode = "official" as const;

  private status: ProviderStatus;
  private socket: ReturnType<typeof ioV2> | undefined;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private viewerTimer: ReturnType<typeof setInterval> | undefined;
  private stopped = false;
  private reconnectAttempts = 0;
  private lastEventStatusEmitAt = 0;

  constructor(
    private readonly config: AppConfig,
    private readonly getToken: () => ChzzkTokenSet | undefined,
    private readonly setToken: (token: ChzzkTokenSet) => void,
    private readonly callbacks: ProviderCallbacks
  ) {
    this.status = {
      provider: "chzzk",
      sourceMode: "official",
      state: "idle",
      message: "공식 치지직 연결 대기 중"
    };
  }

  async connect() {
    this.stopped = false;
    this.reconnectTimer = undefined;
    this.setStatus("connecting", "치지직 공식 세션을 생성하는 중");

    const token = await this.ensureAccessToken();
    if (!token) {
      this.setStatus("auth_required", "관리 화면에서 치지직 공식 로그인이 필요합니다.");
      return;
    }

    const sessionUrl = await this.createSession(token.accessToken);
    this.connectSocket(sessionUrl);
  }

  async disconnect() {
    this.stopped = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
    }
    this.stopViewerPolling();
    if (this.socket) {
      this.socket.disconnect();
      this.socket = undefined;
    }
    this.setStatus("idle", "공식 치지직 연결이 해제되었습니다.");
  }

  getStatus() {
    return this.status;
  }

  private connectSocket(url: string) {
    this.socket?.disconnect();
    this.socket = ioV2(url, {
      transports: ["websocket"],
      reconnection: false,
      timeout: 10_000,
      forceNew: true
    });

    this.socket.on("connect", () => {
      this.reconnectAttempts = 0;
      this.setStatus("connected", "치지직 공식 세션에 연결되었습니다.", { connectedAt: Date.now() });
      this.startViewerPolling();
    });

    this.socket.on("disconnect", () => {
      if (!this.stopped) {
        this.scheduleReconnect("치지직 공식 세션 연결이 끊겼습니다.");
      }
    });

    this.socket.on("connect_error", (error: Error) => {
      this.scheduleReconnect(`치지직 공식 세션 연결 오류: ${error.message}`);
    });

    this.socket.on("SYSTEM", (payload: unknown) => this.handleSystemPayload(payload));
    this.socket.on("CHAT", (payload: unknown) => this.handleChatPayload(payload));
    this.socket.on("message", (payload: unknown) => this.handleAnyPayload(payload));
  }

  private handleAnyPayload(payload: unknown) {
    if (!payload || typeof payload !== "object") {
      return;
    }

    const record = payload as Record<string, unknown>;
    const type = record.type ?? record.eventType;

    if (type === "CHAT" || "content" in record) {
      this.handleChatPayload(payload);
      return;
    }

    if (type === "SYSTEM" || "sessionKey" in record) {
      this.handleSystemPayload(payload);
    }
  }

  private handleSystemPayload(payload: unknown) {
    if (!payload || typeof payload !== "object") {
      return;
    }

    const record = payload as Record<string, unknown>;
    const body = "data" in record && record.data && typeof record.data === "object"
      ? (record.data as Record<string, unknown>)
      : record;

    const sessionKey = typeof body.sessionKey === "string" ? body.sessionKey : undefined;
    if (sessionKey) {
      void this.subscribeChat(sessionKey);
    }
  }

  private handleChatPayload(payload: unknown) {
    const body = this.unwrapPayload(payload);
    if (!body || typeof body !== "object") {
      return;
    }

    const message = normalizeOfficialChzzkChatEvent(body as Parameters<typeof normalizeOfficialChzzkChatEvent>[0]);
    this.status = { ...this.status, lastEventAt: Date.now(), channelId: message.channelId };
    this.callbacks.onMessage(message);
    this.emitEventStatusThrottled();
  }

  /** lastEventAt 갱신용 상태 브로드캐스트 — 메시지마다가 아니라 5초에 1번만 */
  private emitEventStatusThrottled() {
    const now = Date.now();
    if (now - this.lastEventStatusEmitAt < 5_000) {
      return;
    }
    this.lastEventStatusEmitAt = now;
    this.callbacks.onStatus(this.status);
  }

  private unwrapPayload(payload: unknown) {
    if (!payload || typeof payload !== "object") {
      return payload;
    }
    const record = payload as Record<string, unknown>;
    return record.data && typeof record.data === "object" ? record.data : payload;
  }

  private async subscribeChat(sessionKey: string) {
    const token = await this.ensureAccessToken();
    if (!token) {
      this.setStatus("auth_required", "채팅 이벤트 구독을 위한 Access Token이 없습니다.");
      return;
    }

    const response = await fetch(`${CHZZK_OPEN_API_BASE}/open/v1/sessions/events/subscribe/chat?sessionKey=${encodeURIComponent(sessionKey)}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token.accessToken}`,
        "Content-Type": "application/json"
      }
    });

    if (!response.ok) {
      throw new Error(`채팅 이벤트 구독 실패 (${response.status})`);
    }
  }

  private async createSession(accessToken: string) {
    const response = await fetch(`${CHZZK_OPEN_API_BASE}/open/v1/sessions/auth`, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json"
      }
    });

    if (!response.ok) {
      throw new Error(`세션 생성 실패 (${response.status})`);
    }

    const json = (await response.json()) as ChzzkSessionResponse;
    const url = json.content?.url;
    if (!url) {
      throw new Error("치지직 세션 URL 응답이 비어 있습니다.");
    }

    return url;
  }

  private async ensureAccessToken() {
    const token = this.getToken();
    if (!token) {
      return undefined;
    }

    if (token.expiresAt - Date.now() > 60_000) {
      return token;
    }

    if (!token.refreshToken) {
      return token;
    }

    if (!this.config.chzzkClientId || !this.config.chzzkClientSecret) {
      return token;
    }

    const response = await fetch(`${CHZZK_OPEN_API_BASE}/auth/v1/token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        grantType: "refresh_token",
        refreshToken: token.refreshToken,
        clientId: this.config.chzzkClientId,
        clientSecret: this.config.chzzkClientSecret
      })
    });

    if (!response.ok) {
      return token;
    }

    const nextToken = parseChzzkTokenResponse(await response.json(), token.refreshToken);
    if (!nextToken) {
      return token;
    }
    this.setToken(nextToken);
    return nextToken;
  }

  private startViewerPolling() {
    this.stopViewerPolling();
    this.viewerTimer = setInterval(() => {
      const channelId = this.status.channelId;
      if (!channelId) {
        return;
      }
      void fetchChzzkViewerCount(channelId)
        .then((count) => {
          if (typeof count !== "number") {
            return;
          }
          this.status = { ...this.status, viewerCount: count };
          this.callbacks.onViewerCount?.("chzzk", count);
          this.callbacks.onStatus(this.status);
        })
        .catch(() => undefined);
    }, 10_000);
  }

  private stopViewerPolling() {
    if (this.viewerTimer) {
      clearInterval(this.viewerTimer);
      this.viewerTimer = undefined;
    }
  }

  private scheduleReconnect(message: string) {
    if (this.stopped || this.reconnectTimer) {
      return;
    }

    this.reconnectAttempts += 1;
    const delay = computeReconnectDelayMs(this.reconnectAttempts);
    this.setStatus("reconnecting", `${message} ${Math.round(delay / 1000)}초 후 재연결합니다.`);
    this.reconnectTimer = setTimeout(() => {
      void this.connect().catch((error) => {
        this.setStatus("error", error instanceof Error ? error.message : "공식 재연결 실패");
      });
    }, delay);
  }

  private setStatus(state: ProviderStatus["state"], message: string, patch: Partial<ProviderStatus> = {}) {
    this.status = {
      provider: "chzzk",
      sourceMode: "official",
      state,
      message,
      channelId: this.status.channelId,
      connectedAt: this.status.connectedAt,
      lastEventAt: this.status.lastEventAt,
      ...patch
    };
    this.callbacks.onStatus(this.status);
  }
}
