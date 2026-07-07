import { normalizeUnofficialChzzkChatEvent } from "./chzzkNormalizer";
import { computeReconnectDelayMs } from "./reconnectBackoff";
import type { ProviderAdapter, ProviderCallbacks } from "./types";
import type { ProviderStatus } from "../../shared/types";

interface LiveDetailResponse {
  code?: number;
  message?: string;
  content?: {
    channel?: {
      channelId?: string;
      channelName?: string;
    };
    chatChannelId?: string;
    liveTitle?: string;
    status?: string;
    concurrentUserCount?: number;
  };
}

interface AccessTokenResponse {
  content?: {
    accessToken?: string;
    realNameAuth?: boolean;
    temporaryRestrict?: boolean;
  };
}

interface NaverChatPacket {
  cmd?: number;
  bdy?: unknown;
}

const CHAT_COMMANDS = new Set([93101, 93102, 93103]);
const CHZZK_USER_AGENT = "Mozilla/5.0 chzzk-multichat-overlay";
const VIEWER_POLL_INTERVAL_MS = 10_000;
const EVENT_STATUS_EMIT_INTERVAL_MS = 5_000;
const SUPPORTED_CHZZK_HOSTS = ["chzzk.naver.com", "m.chzzk.naver.com"];
const RESERVED_CHZZK_URL_SEGMENTS = new Set(["live", "channel", "clips", "video", "category", "search", "following"]);

export class ChzzkUnofficialAdapter implements ProviderAdapter {
  readonly provider = "chzzk" as const;
  readonly sourceMode = "unofficial" as const;

  private status: ProviderStatus;
  private socket: WebSocket | undefined;
  private pingTimer: ReturnType<typeof setInterval> | undefined;
  private viewerTimer: ReturnType<typeof setInterval> | undefined;
  private stopped = false;
  private activeChannelId = "";
  private lastEventStatusEmitAt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private reconnectAttempts = 0;

  constructor(
    private readonly channelInput: string,
    private readonly callbacks: ProviderCallbacks
  ) {
    this.status = {
      provider: "chzzk",
      sourceMode: "unofficial",
      state: "idle",
      channelId: channelInput,
      message: "비공식 치지직 연결 대기 중"
    };
  }

  async connect() {
    this.stopped = false;
    this.reconnectTimer = undefined;

    // 파싱을 먼저 해서 activeChannelId를 확정해야 한다 — 순서를 바꾸면 setStatus가
    // 원본 입력값(URL 전체일 수 있음)을 channelId로 굳히고, 이후 reportViewerCount가
    // 그 값을 그대로 복사해 끝까지 잘못된 channelId가 유지된다.
    const channel = parseChzzkChannelInput(this.channelInput);
    if (!channel) {
      this.setStatus("unsupported", "비공식 모드는 공개 치지직 채널 ID 또는 라이브 URL이 필요합니다.");
      return;
    }
    this.activeChannelId = channel.channelId;
    this.setStatus("connecting", "치지직 공개 채팅 메타데이터를 확인하는 중");

    const liveDetail = await this.fetchLiveDetail(channel.channelId);
    this.reportViewerCount(liveDetail.content?.concurrentUserCount);
    const chatChannelId = liveDetail.content?.chatChannelId;
    if (!chatChannelId) {
      this.setStatus("offline", "현재 공개 라이브 채팅 채널을 찾지 못했습니다.", {
        channelId: channel.channelId
      });
      return;
    }

    const accessToken = await this.fetchChatAccessToken(channel.channelId, chatChannelId);
    if (!accessToken) {
      this.setStatus(
        "unsupported",
        "공개 채팅 토큰을 받을 수 없습니다. 치지직 웹 프로토콜이 바뀌었거나 로그인이 필요합니다.",
        { channelId: channel.channelId }
      );
      return;
    }

    this.connectSocket(channel.channelId, chatChannelId, accessToken);
  }

  async disconnect() {
    this.stopped = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = undefined;
    }
    this.stopViewerPolling();
    if (this.socket) {
      this.socket.close();
      this.socket = undefined;
    }
    this.setStatus("idle", "비공식 치지직 연결이 해제되었습니다.");
  }

  getStatus() {
    return this.status;
  }

  private async fetchLiveDetail(channelId: string) {
    const headers = {
      Accept: "application/json",
      Origin: "https://chzzk.naver.com",
      Referer: `https://chzzk.naver.com/live/${encodeURIComponent(channelId)}`,
      "User-Agent": CHZZK_USER_AGENT
    };
    const endpoints = [
      {
        label: "live-status",
        url: `https://api.chzzk.naver.com/polling/v2/channels/${encodeURIComponent(channelId)}/live-status`
      },
      {
        label: "legacy live-detail",
        url: `https://api.chzzk.naver.com/service/v3/channels/${encodeURIComponent(channelId)}/live-detail`
      }
    ];
    const errors: string[] = [];

    for (const endpoint of endpoints) {
      const response = await fetch(endpoint.url, { headers });
      if (response.ok) {
        return (await response.json()) as LiveDetailResponse;
      }
      errors.push(`${endpoint.label} ${response.status}${await formatResponseHint(response)}`);
    }

    throw new Error(`치지직 공개 라이브 정보 조회 실패 (${errors.join(" / ")})`);
  }

  private async fetchChatAccessToken(channelId: string, chatChannelId: string) {
    const response = await fetch(
      `https://comm-api.game.naver.com/nng_main/v1/chats/access-token?channelId=${encodeURIComponent(chatChannelId)}&chatType=STREAMING`,
      {
        headers: {
          Accept: "application/json",
          Origin: "https://chzzk.naver.com",
          Referer: `https://chzzk.naver.com/live/${encodeURIComponent(channelId)}`,
          "User-Agent": CHZZK_USER_AGENT
        }
      }
    );

    if (!response.ok) {
      return undefined;
    }

    const json = (await response.json()) as AccessTokenResponse;
    return json.content?.accessToken;
  }

  private connectSocket(channelId: string, chatChannelId: string, accessToken: string) {
    const socket = new WebSocket("wss://kr-ss1.chat.naver.com/chat");
    this.socket = socket;

    socket.addEventListener("open", () => {
      this.sendPacket({
        ver: "2",
        cmd: 100,
        svcid: "game",
        cid: chatChannelId,
        bdy: {
          uid: null,
          devType: 2001,
          accTkn: accessToken,
          auth: "READ"
        },
        tid: 1
      });
      this.pingTimer = setInterval(() => this.sendPacket({ ver: "2", cmd: 0 }), 20_000);
      this.reconnectAttempts = 0;
      this.setStatus("connected", "치지직 비공식 공개 채팅에 연결되었습니다.", {
        connectedAt: Date.now(),
        channelId
      });
      this.startViewerPolling(channelId);
    });

    socket.addEventListener("message", (event) => this.handleSocketMessage(event.data));
    socket.addEventListener("close", () => {
      if (!this.stopped) {
        this.scheduleReconnect("비공식 공개 채팅 연결이 끊겼습니다.");
      }
    });
    socket.addEventListener("error", () => {
      this.setStatus(
        "unsupported",
        "비공식 공개 채팅 웹소켓 연결에 실패했습니다. 치지직 웹 프로토콜 변경 가능성이 큽니다."
      );
    });
  }

  private handleSocketMessage(data: unknown) {
    if (typeof data !== "string") {
      return;
    }

    const packet = parsePacket(data);
    if (!packet?.cmd || !CHAT_COMMANDS.has(packet.cmd)) {
      return;
    }

    const body = Array.isArray(packet.bdy) ? packet.bdy : [packet.bdy];
    for (const item of body) {
      if (!item || typeof item !== "object") {
        continue;
      }
      const message = normalizeUnofficialChzzkChatEvent(
        item as Parameters<typeof normalizeUnofficialChzzkChatEvent>[0],
        this.activeChannelId || this.channelInput
      );
      if (!message.content.trim()) {
        continue;
      }
      this.status = { ...this.status, lastEventAt: Date.now() };
      this.callbacks.onMessage(message);
      this.emitEventStatusThrottled();
    }
  }

  /** lastEventAt 갱신용 상태 브로드캐스트 — 메시지마다가 아니라 5초에 1번만 */
  private emitEventStatusThrottled() {
    const now = Date.now();
    if (now - this.lastEventStatusEmitAt < EVENT_STATUS_EMIT_INTERVAL_MS) {
      return;
    }
    this.lastEventStatusEmitAt = now;
    this.callbacks.onStatus(this.status);
  }

  private sendPacket(packet: unknown) {
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(packet));
    }
  }

  private startViewerPolling(channelId: string) {
    this.stopViewerPolling();
    this.viewerTimer = setInterval(() => {
      void fetchChzzkViewerCount(channelId)
        .then((count) => this.reportViewerCount(count))
        .catch(() => undefined);
    }, VIEWER_POLL_INTERVAL_MS);
  }

  private stopViewerPolling() {
    if (this.viewerTimer) {
      clearInterval(this.viewerTimer);
      this.viewerTimer = undefined;
    }
  }

  private reportViewerCount(count: number | undefined) {
    if (typeof count !== "number" || !Number.isFinite(count) || count < 0) {
      return;
    }
    this.status = { ...this.status, viewerCount: count };
    this.callbacks.onViewerCount?.("chzzk", count);
    this.callbacks.onStatus(this.status);
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
        this.setStatus("error", error instanceof Error ? error.message : "비공식 재연결 실패");
      });
    }, delay);
  }

  private setStatus(state: ProviderStatus["state"], message: string, patch: Partial<ProviderStatus> = {}) {
    this.status = {
      provider: "chzzk",
      sourceMode: "unofficial",
      state,
      message,
      channelId: this.activeChannelId || this.channelInput,
      connectedAt: this.status.connectedAt,
      lastEventAt: this.status.lastEventAt,
      ...patch
    };
    this.callbacks.onStatus(this.status);
  }
}

export async function fetchChzzkViewerCount(channelId: string): Promise<number | undefined> {
  const response = await fetch(
    `https://api.chzzk.naver.com/polling/v2/channels/${encodeURIComponent(channelId)}/live-status`,
    {
      headers: {
        Accept: "application/json",
        Origin: "https://chzzk.naver.com",
        Referer: `https://chzzk.naver.com/live/${encodeURIComponent(channelId)}`,
        "User-Agent": CHZZK_USER_AGENT
      }
    }
  );
  if (!response.ok) {
    return undefined;
  }
  const json = (await response.json()) as LiveDetailResponse;
  const count = json.content?.concurrentUserCount;
  return typeof count === "number" && Number.isFinite(count) && count >= 0 ? count : undefined;
}

function parsePacket(data: string): NaverChatPacket | undefined {
  try {
    const parsed = JSON.parse(data);
    return parsed && typeof parsed === "object" ? (parsed as NaverChatPacket) : undefined;
  } catch {
    return undefined;
  }
}

export function parseChzzkChannelInput(input: string) {
  const value = input.trim();
  if (!value) {
    return undefined;
  }

  const plainId = value.replace(/^@/, "");
  if (isValidChzzkChannelId(plainId)) {
    return { channelId: plainId };
  }

  try {
    const url = new URL(hasUrlScheme(value) ? value : `https://${value}`);
    if (!isSupportedChzzkHost(url.hostname)) {
      return undefined;
    }
    return parseChzzkUrl(url);
  } catch {
    return undefined;
  }
}

function parseChzzkUrl(url: URL) {
  const queryChannelId = firstValidQueryParam(url, ["channelId", "channel_id", "cid"]);
  if (queryChannelId) {
    return { channelId: queryChannelId };
  }

  const segments = url.pathname.split("/").map(decodePathSegment).filter(Boolean);
  if (segments.length === 0) {
    return undefined;
  }

  const explicitSegment = segments.find((segment, index) => {
    const previous = segments[index - 1]?.toLowerCase();
    return (previous === "live" || previous === "channel") && isValidChzzkChannelId(segment);
  });
  if (explicitSegment) {
    return { channelId: explicitSegment };
  }

  const fallbackSegment = segments.find((segment) => isValidChzzkChannelId(segment) && !RESERVED_CHZZK_URL_SEGMENTS.has(segment.toLowerCase()));
  return fallbackSegment ? { channelId: fallbackSegment } : undefined;
}

function hasUrlScheme(value: string) {
  return /^[a-z][a-z\d+.-]*:\/\//i.test(value);
}

function isSupportedChzzkHost(hostname: string) {
  const host = hostname.toLowerCase();
  return SUPPORTED_CHZZK_HOSTS.some((domain) => host === domain || host.endsWith(`.${domain}`));
}

function firstValidQueryParam(url: URL, keys: string[]) {
  for (const key of keys) {
    const value = url.searchParams.get(key);
    if (value && isValidChzzkChannelId(value)) {
      return value;
    }
  }
  return undefined;
}

function isValidChzzkChannelId(value: string) {
  return /^[A-Za-z0-9_-]{2,80}$/.test(value);
}

function decodePathSegment(segment: string) {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

async function formatResponseHint(response: Response) {
  try {
    const text = await response.text();
    const compact = text.replace(/\s+/g, " ").trim().slice(0, 160);
    return compact ? `: ${compact}` : "";
  } catch {
    return "";
  }
}
