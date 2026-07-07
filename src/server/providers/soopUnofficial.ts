import NodeWebSocket from "ws";
import { computeReconnectDelayMs } from "./reconnectBackoff";
import { normalizeSoopChatPacket, parseSoopPacket, SOOP_SERVICE, type SoopPacket } from "./soopNormalizer";
import type { ProviderAdapter, ProviderCallbacks } from "./types";
import type { ProviderStatus } from "../../shared/types";

interface SoopLiveApiResponse {
  CHANNEL?: SoopChannelInfo;
}

interface SoopChannelInfo {
  RESULT?: number | string;
  BJID?: string;
  BJNICK?: string;
  BNO?: string;
  CHATNO?: string;
  CHATPORT?: string;
  CHATIP?: string;
  CHDOMAIN?: string;
  CHIP?: string;
  CHPT?: string;
  FTK?: string;
  TITLE?: string;
}

interface SoopLiveInfo {
  bjId: string;
  broadNo?: string;
  chatNo: string;
  fanTicket: string;
  chatHosts: string[];
  chatPort: number;
  title?: string;
}

interface SoopEndpoint {
  url: string;
  label: string;
}

interface ParsedSoopChannel {
  bjId: string;
  broadNo?: string;
}

const LIVE_API_URL = "https://live.sooplive.co.kr/afreeca/player_live_api.php";
const SOOP_PLAY_ORIGIN = "https://play.sooplive.co.kr";
const SOOP_KR_ROOT_DOMAIN = "sooplive.co.kr";
const SOOP_GLOBAL_ROOT_DOMAIN = "sooplive.com";
const SOOP_USER_AGENT = "Mozilla/5.0 soop-multichat-overlay";
const FIELD_SEPARATOR = new Uint8Array([12]);
const GUEST_FLAG = "16";
const SOCKET_TIMEOUT_MS = 8_000;
const VIEWER_POLL_INTERVAL_MS = 10_000;
const EVENT_STATUS_EMIT_INTERVAL_MS = 5_000;
const STATION_API_ORIGINS = ["https://chapi.sooplive.co.kr", "https://bjapi.afreecatv.com"];
const SUPPORTED_SOOP_HOSTS = ["sooplive.co.kr", "sooplive.com", "afreecatv.com"];
const RESERVED_URL_SEGMENTS = new Set(["station", "channel", "ch", "profile", "live", "vod", "catch", "player"]);

export class SoopUnofficialAdapter implements ProviderAdapter {
  readonly provider = "soop" as const;
  readonly sourceMode = "unofficial" as const;

  private status: ProviderStatus;
  private socket: NodeWebSocket | undefined;
  private keepaliveTimer: ReturnType<typeof setInterval> | undefined;
  private viewerTimer: ReturnType<typeof setInterval> | undefined;
  private stopped = false;
  private liveInfo: SoopLiveInfo | undefined;
  private lastEventStatusEmitAt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private reconnectAttempts = 0;

  constructor(
    private readonly channelInput: string,
    private readonly callbacks: ProviderCallbacks
  ) {
    this.status = {
      provider: "soop",
      sourceMode: "unofficial",
      state: "idle",
      channelId: channelInput,
      message: "SOOP 공개 채팅 연결 대기 중"
    };
  }

  async connect() {
    this.stopped = false;
    this.reconnectTimer = undefined;

    // 파싱을 먼저 해서 bjId를 확정해야 한다 — liveInfo가 채워지기 전에 setStatus를
    // 부르면 channelId가 원본 입력값(URL 전체일 수 있음)으로 굳어버린다.
    const channel = parseSoopChannelInput(this.channelInput);
    if (!channel) {
      this.setStatus("unsupported", "SOOP BJ ID 또는 방송 URL을 입력해주세요.");
      return;
    }
    this.setStatus("connecting", "SOOP 공개 방송 정보를 확인하는 중", { channelId: channel.bjId });

    this.liveInfo = await this.fetchLiveInfo(channel.bjId, channel.broadNo);
    if (this.liveInfo.chatHosts.length === 0 || !this.liveInfo.chatNo || !this.liveInfo.fanTicket) {
      this.setStatus("offline", "현재 SOOP 공개 채팅 정보를 찾지 못했습니다.", {
        channelId: channel.bjId
      });
      return;
    }

    const endpoints = buildEndpoints(this.liveInfo);
    if (endpoints.length === 0) {
      this.setStatus("unsupported", "SOOP 채팅 서버 주소를 만들 수 없습니다.", {
        channelId: channel.bjId
      });
      return;
    }

    await this.connectFirstEndpoint(endpoints);
  }

  async disconnect() {
    this.stopped = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    if (this.keepaliveTimer) {
      clearInterval(this.keepaliveTimer);
      this.keepaliveTimer = undefined;
    }
    this.stopViewerPolling();
    if (this.socket) {
      this.socket.close();
      this.socket = undefined;
    }
    this.setStatus("idle", "SOOP 공개 채팅 연결이 해제되었습니다.");
  }

  getStatus() {
    return this.status;
  }

  private async fetchLiveInfo(bjId: string, broadNo?: string): Promise<SoopLiveInfo> {
    const body = new URLSearchParams({
      bid: bjId,
      type: "live",
      pwd: "",
      player_type: "html5",
      stream_type: "common",
      quality: "HD",
      mode: "landing",
      from_api: "0"
    });

    if (broadNo) {
      body.set("bno", broadNo);
    }

    const response = await fetch(LIVE_API_URL, {
      method: "POST",
      headers: {
        Accept: "application/json, text/plain, */*",
        "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
        Origin: SOOP_PLAY_ORIGIN,
        Referer: `${SOOP_PLAY_ORIGIN}/${encodeURIComponent(bjId)}${broadNo ? `/${encodeURIComponent(broadNo)}` : ""}`,
        "User-Agent": SOOP_USER_AGENT
      },
      body
    });

    if (!response.ok) {
      throw new Error(`SOOP 라이브 정보 조회 실패 (${response.status})`);
    }

    const json = (await response.json()) as SoopLiveApiResponse;
    const channel = json.CHANNEL;
    const result = Number(channel?.RESULT ?? 0);
    if (!channel || result !== 1) {
      throw new Error(`SOOP 방송 정보를 찾지 못했습니다. BJ ID와 방송 상태를 확인해주세요. (${channel?.RESULT ?? "empty"})`);
    }

    const chatNo = channel.CHATNO ?? "";
    const fanTicket = channel.FTK ?? "";
    const chatPort = Number(channel.CHPT ?? channel.CHATPORT ?? 0);
    const chatHosts = deriveChatHosts(channel);

    return {
      bjId: channel.BJID || bjId,
      broadNo: channel.BNO || broadNo,
      chatNo,
      fanTicket,
      chatHosts,
      chatPort,
      title: channel.TITLE
    };
  }

  private async connectFirstEndpoint(endpoints: SoopEndpoint[]) {
    const errors: string[] = [];

    for (const endpoint of endpoints) {
      if (this.stopped) {
        return;
      }

      this.setStatus("connecting", `SOOP 채팅 서버 접속 시도 중 (${endpoint.label})`, {
        channelId: this.liveInfo?.bjId
      });

      try {
        await this.openSocket(endpoint);
        return;
      } catch (error) {
        errors.push(error instanceof Error ? error.message : endpoint.url);
      }
    }

    this.setStatus(
      "unsupported",
      `SOOP 채팅 WebSocket 접속에 실패했습니다. 공개 프로토콜이 변경됐거나 네트워크에서 채팅 포트가 막혔을 수 있습니다.${formatEndpointErrors(errors)}`,
      { channelId: this.liveInfo?.bjId }
    );
  }

  private openSocket(endpoint: SoopEndpoint) {
    return new Promise<void>((resolve, reject) => {
      let opened = false;
      let settled = false;
      const socket = new NodeWebSocket(endpoint.url, "chat", {
        headers: {
          Origin: SOOP_PLAY_ORIGIN,
          Referer: this.buildReferer(),
          "User-Agent": SOOP_USER_AGENT
        },
        handshakeTimeout: SOCKET_TIMEOUT_MS,
        perMessageDeflate: false
      });
      this.socket = socket;

      const fail = (error: Error) => {
        if (settled) {
          return;
        }
        settled = true;
        reject(error);
      };

      const timeout = setTimeout(() => {
        if (!opened) {
          socket.terminate();
          fail(new Error(`${endpoint.label} 응답 시간 초과`));
        }
      }, SOCKET_TIMEOUT_MS);

      socket.once("open", () => {
        opened = true;
        settled = true;
        clearTimeout(timeout);
        this.setStatus("connecting", "SOOP 채팅 서버에 접속했습니다. 게스트 로그인 중", {
          channelId: this.liveInfo?.bjId
        });
        this.startKeepalive();
        this.sendLogin();
        resolve();
      });

      socket.on("message", (data) => {
        void this.handleSocketMessage(data);
      });

      socket.once("close", () => {
        clearTimeout(timeout);
        if (!opened) {
          fail(new Error(`${endpoint.label} 접속 실패`));
          return;
        }
        if (!this.stopped) {
          this.scheduleReconnect("SOOP 공개 채팅 연결이 끊겼습니다.");
        }
      });

      socket.once("error", (error) => {
        clearTimeout(timeout);
        if (!opened) {
          fail(new Error(`${endpoint.label} WebSocket 오류: ${error.message}`));
          return;
        }
        if (!this.stopped) {
          this.scheduleReconnect(`SOOP 공개 채팅 WebSocket 오류가 발생했습니다: ${error.message}`);
        }
      });
    });
  }

  private async handleSocketMessage(data: unknown) {
    const packet = await parseSocketData(data);
    if (!packet) {
      return;
    }

    if (packet.retCode > 0) {
      this.handlePacketError(packet);
      return;
    }

    if (packet.serviceCode === SOOP_SERVICE.LOGIN) {
      this.sendJoinChannel();
      return;
    }

    if (packet.serviceCode === SOOP_SERVICE.JOIN_CHANNEL) {
      this.reconnectAttempts = 0;
      this.setStatus("connected", this.buildConnectedMessage(), {
        channelId: this.liveInfo?.bjId,
        connectedAt: Date.now()
      });
      this.startViewerPolling();
      return;
    }

    const message = normalizeSoopChatPacket(packet, this.liveInfo?.bjId ?? this.channelInput);
    if (!message) {
      return;
    }

    this.status = { ...this.status, lastEventAt: Date.now() };
    this.callbacks.onMessage(message);
    this.emitEventStatusThrottled();
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

  private handlePacketError(packet: SoopPacket) {
    const errorMessage = mapSoopError(packet.retCode);
    const state = packet.retCode === 35 || packet.retCode === 55 ? "unsupported" : "error";
    this.setStatus(state, errorMessage, {
      channelId: this.liveInfo?.bjId
    });
  }

  private sendLogin() {
    this.sendPacket(SOOP_SERVICE.LOGIN, ["", "", GUEST_FLAG]);
  }

  private sendJoinChannel() {
    if (!this.liveInfo) {
      return;
    }
    this.sendPacket(SOOP_SERVICE.JOIN_CHANNEL, [this.liveInfo.chatNo, this.liveInfo.fanTicket, "0", "", ""]);
  }

  private startViewerPolling() {
    this.stopViewerPolling();
    const bjId = this.liveInfo?.bjId;
    if (!bjId) {
      return;
    }
    const poll = () => {
      void fetchSoopViewerCount(bjId)
        .then((result) => {
          if (!result) {
            return;
          }
          this.reportViewerCount(result.count);
          // 방송 종료(station API의 broad=null) 감지 — 실제 연결 해제는 index.ts가 처리한다.
          if (!result.live && !this.stopped) {
            this.setStatus("offline", "방송이 종료되어 채팅 연결을 해제합니다.");
          }
        })
        .catch(() => undefined);
    };
    poll();
    this.viewerTimer = setInterval(poll, VIEWER_POLL_INTERVAL_MS);
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
    this.callbacks.onViewerCount?.("soop", count);
    this.callbacks.onStatus(this.status);
  }

  private scheduleReconnect(message: string) {
    if (this.stopped || this.reconnectTimer) {
      return;
    }
    this.reconnectAttempts += 1;
    const delay = computeReconnectDelayMs(this.reconnectAttempts);
    this.setStatus("reconnecting", `${message} ${Math.round(delay / 1000)}초 후 재연결합니다.`, {
      channelId: this.liveInfo?.bjId
    });
    this.reconnectTimer = setTimeout(() => {
      void this.connect().catch((error) => {
        this.setStatus("error", error instanceof Error ? error.message : "SOOP 재연결 실패");
      });
    }, delay);
  }

  private startKeepalive() {
    if (this.keepaliveTimer) {
      clearInterval(this.keepaliveTimer);
    }
    this.keepaliveTimer = setInterval(() => {
      this.sendPacket(SOOP_SERVICE.KEEPALIVE, []);
    }, 60_000);
  }

  private sendPacket(serviceCode: number, fields: Array<string | Uint8Array>) {
    if (this.socket?.readyState !== NodeWebSocket.OPEN) {
      return;
    }
    this.socket.send(makeSoopPacket(serviceCode, fields));
  }

  private buildReferer() {
    const bjId = this.liveInfo?.bjId ?? this.channelInput;
    const broadNo = this.liveInfo?.broadNo;
    return `${SOOP_PLAY_ORIGIN}/${encodeURIComponent(bjId)}${broadNo ? `/${encodeURIComponent(broadNo)}` : ""}`;
  }

  private buildConnectedMessage() {
    const suffix = this.liveInfo?.title ? `: ${this.liveInfo.title}` : "";
    return `SOOP 공개 채팅에 연결되었습니다${suffix}`;
  }

  private setStatus(state: ProviderStatus["state"], message: string, patch: Partial<ProviderStatus> = {}) {
    this.status = {
      provider: "soop",
      sourceMode: "unofficial",
      state,
      message,
      channelId: this.liveInfo?.bjId ?? this.channelInput,
      connectedAt: this.status.connectedAt,
      lastEventAt: this.status.lastEventAt,
      ...patch
    };
    this.callbacks.onStatus(this.status);
  }
}

export interface SoopLiveStatusResult {
  count?: number;
  /** false면 station API의 broad가 null — 방송이 종료된 것으로 판단 */
  live: boolean;
}

export async function fetchSoopViewerCount(bjId: string): Promise<SoopLiveStatusResult | undefined> {
  for (const origin of STATION_API_ORIGINS) {
    try {
      const response = await fetch(`${origin}/api/${encodeURIComponent(bjId)}/station`, {
        headers: {
          Accept: "application/json",
          Referer: `https://ch.sooplive.co.kr/${encodeURIComponent(bjId)}`,
          "User-Agent": SOOP_USER_AGENT
        }
      });
      if (!response.ok) {
        continue;
      }
      const json = (await response.json()) as { broad?: { current_sum_viewer?: number | string } | null };
      const count = Number(json.broad?.current_sum_viewer);
      return {
        count: Number.isFinite(count) && count >= 0 ? count : undefined,
        live: json.broad != null
      };
    } catch {
      // 다음 origin으로 폴백
    }
  }
  return undefined;
}

async function parseSocketData(data: unknown) {
  if (data instanceof ArrayBuffer || ArrayBuffer.isView(data) || typeof data === "string") {
    return parseSoopPacket(data);
  }

  if (Array.isArray(data) && data.every((part) => ArrayBuffer.isView(part))) {
    return parseSoopPacket(
      concatBytes(data.map((part) => new Uint8Array(part.buffer, part.byteOffset, part.byteLength)))
    );
  }

  if (typeof Blob !== "undefined" && data instanceof Blob) {
    return parseSoopPacket(await data.arrayBuffer());
  }

  return undefined;
}

function makeSoopPacket(serviceCode: number, fields: Array<string | Uint8Array>) {
  const body = concatBytes([FIELD_SEPARATOR, ...fields.flatMap((field) => [toBytes(field), FIELD_SEPARATOR])]);
  const header = toAsciiBytes(`\u001b\t${String(serviceCode).padStart(4, "0")}${String(body.byteLength).padStart(6, "0")}00`);
  return concatBytes([header, body]).buffer;
}

function toBytes(field: string | Uint8Array) {
  return field instanceof Uint8Array ? field : new TextEncoder().encode(field);
}

function toAsciiBytes(value: string) {
  return Uint8Array.from(Array.from(value, (char) => char.charCodeAt(0)));
}

function concatBytes(parts: Uint8Array[]) {
  const length = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.byteLength;
  }
  return bytes;
}

export function parseSoopChannelInput(input: string): ParsedSoopChannel | undefined {
  const value = input.trim();
  if (!value) {
    return undefined;
  }

  const plainId = value.replace(/^@/, "");
  if (isValidBjId(plainId)) {
    return { bjId: plainId };
  }

  try {
    const url = new URL(hasUrlScheme(value) ? value : `https://${value}`);
    if (isSupportedSoopHost(url.hostname)) {
      return parseSoopUrl(url);
    }
  } catch {
    // Fall through to plain BJ ID parsing.
  }

  return undefined;
}

function parseSoopUrl(url: URL): ParsedSoopChannel | undefined {
  const queryBjId = firstValidQueryParam(url, ["bjid", "bid", "user_id", "szBjId"]);
  if (queryBjId) {
    return { bjId: queryBjId, broadNo: firstValidBroadNo(url.searchParams.get("bno") ?? url.searchParams.get("broad_no")) };
  }

  const segments = url.pathname.split("/").map(decodePathSegment).filter(Boolean);
  const host = url.hostname.toLowerCase();
  const bjIndex =
    host.startsWith("play.") || host.startsWith("ch.") || host.includes("afreecatv.com")
      ? 0
      : segments.findIndex((segment) => isValidBjId(segment) && !RESERVED_URL_SEGMENTS.has(segment.toLowerCase()));

  if (bjIndex < 0) {
    return undefined;
  }

  const bjId = segments[bjIndex];
  if (!isValidBjId(bjId)) {
    return undefined;
  }

  return { bjId, broadNo: firstValidBroadNo(segments[bjIndex + 1]) };
}

function hasUrlScheme(value: string) {
  return /^[a-z][a-z\d+.-]*:\/\//i.test(value);
}

function isSupportedSoopHost(hostname: string) {
  const host = hostname.toLowerCase();
  return SUPPORTED_SOOP_HOSTS.some((domain) => host === domain || host.endsWith(`.${domain}`));
}

function firstValidQueryParam(url: URL, keys: string[]) {
  for (const key of keys) {
    const value = url.searchParams.get(key);
    if (value && isValidBjId(value)) {
      return value;
    }
  }
  return undefined;
}

function firstValidBroadNo(value: string | undefined | null) {
  return value && /^[A-Za-z0-9_-]{1,80}$/.test(value) ? value : undefined;
}

function isValidBjId(value: string) {
  return /^[A-Za-z0-9_-]{2,40}$/.test(value);
}

function decodePathSegment(segment: string) {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

export function buildEndpoints(info: SoopLiveInfo) {
  const endpoints: SoopEndpoint[] = [];
  const wssPort = info.chatPort + 1;
  const safeBjId = encodeURIComponent(info.bjId);
  const domainHosts = info.chatHosts.filter((host) => !isIpAddress(host));

  if (info.chatPort <= 0) {
    return endpoints;
  }

  for (const host of domainHosts) {
    endpoints.push({
      url: `wss://${host}:${wssPort}/Websocket/${safeBjId}`,
      label: `${host}:${wssPort}`
    });
  }

  for (const host of info.chatHosts) {
    endpoints.push({
      url: `ws://${host}:${info.chatPort}/Websocket/${safeBjId}`,
      label: `${host}:${info.chatPort}`
    });
  }

  for (const host of domainHosts) {
    endpoints.push({
      url: `wss://${host}:${info.chatPort}/Websocket/${safeBjId}`,
      label: `${host}:${info.chatPort}/wss`
    });
  }

  return uniqueEndpoints(endpoints);
}

export function deriveChatHosts(channel: Pick<SoopChannelInfo, "CHDOMAIN" | "CHIP" | "CHATIP">) {
  const candidates = [
    ...hostsFromChatHost(channel.CHDOMAIN),
    ...hostsFromChatHost(channel.CHIP),
    ...hostsFromChatHost(channel.CHATIP)
  ];
  return unique(candidates);
}

function hostsFromChatHost(host: string | undefined) {
  const normalized = normalizeHost(host);
  if (!normalized) {
    return [];
  }

  if (isIpAddress(normalized)) {
    return [domainFromIp(normalized, SOOP_KR_ROOT_DOMAIN), domainFromIp(normalized, SOOP_GLOBAL_ROOT_DOMAIN), normalized];
  }

  if (normalized.endsWith(`.${SOOP_GLOBAL_ROOT_DOMAIN}`)) {
    return [normalized.replace(new RegExp(`\\.${escapeRegExp(SOOP_GLOBAL_ROOT_DOMAIN)}$`), `.${SOOP_KR_ROOT_DOMAIN}`), normalized];
  }

  if (normalized.endsWith(`.${SOOP_KR_ROOT_DOMAIN}`)) {
    return [normalized, normalized.replace(new RegExp(`\\.${escapeRegExp(SOOP_KR_ROOT_DOMAIN)}$`), `.${SOOP_GLOBAL_ROOT_DOMAIN}`)];
  }

  return [normalized];
}

function normalizeHost(host: string | undefined) {
  if (!host) {
    return undefined;
  }
  return host.replace(/^https?:\/\//, "").replace(/^wss?:\/\//, "").replace(/\/.*$/, "").trim();
}

function isIpAddress(value: string) {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(value);
}

function domainFromIp(ip: string, rootDomain: string) {
  if (!isIpAddress(ip)) {
    return undefined;
  }
  const hex = ip
    .split(".")
    .map((part) => Number(part).toString(16).padStart(2, "0"))
    .join("")
    .toUpperCase();
  return `chat-${hex}.${rootDomain}`;
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function unique(values: Array<string | undefined>) {
  return Array.from(new Set(values.filter((value): value is string => Boolean(value))));
}

function uniqueEndpoints(endpoints: SoopEndpoint[]) {
  const seen = new Set<string>();
  return endpoints.filter((endpoint) => {
    if (seen.has(endpoint.url)) {
      return false;
    }
    seen.add(endpoint.url);
    return true;
  });
}

function formatEndpointErrors(errors: string[]) {
  if (errors.length === 0) {
    return "";
  }
  const preview = errors.slice(0, 3).join(" / ");
  const suffix = errors.length > 3 ? ` 외 ${errors.length - 3}개` : "";
  return ` (${preview}${suffix})`;
}

function mapSoopError(code: number) {
  const messages: Record<number, string> = {
    2: "SOOP 채팅 로그인이 필요합니다.",
    16: "SOOP 채팅방에 입장하지 못했습니다.",
    35: "이 방송은 게스트 채팅을 허용하지 않습니다. v1에서는 SOOP 로그인 쿠키 연결을 지원하지 않습니다.",
    41: "강제 퇴장된 계정 또는 세션으로 SOOP 채팅에 입장할 수 없습니다.",
    55: "이 방송은 스트리머가 등록한 이용자만 채팅 참여가 가능합니다."
  };
  return messages[code] ?? `SOOP 채팅 서버 오류가 발생했습니다. (${code})`;
}
