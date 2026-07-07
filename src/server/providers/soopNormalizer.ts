import type { ChatBadge, ChatMessage, ChatRole } from "../../shared/types";

const FIELD_SEPARATOR = 12;
const ESCAPE = 27;
const TAB = 9;

export const SOOP_SERVICE = {
  KEEPALIVE: 0,
  LOGIN: 1,
  JOIN_CHANNEL: 2,
  CHAT_MESSAGE: 5
} as const;

const SOOP_FLAG = {
  ADMIN: 1,
  BJ: 4,
  GUEST: 16,
  FANCLUB: 32,
  MANAGERLIST: 128,
  MANAGER: 256,
  EMPLOYEE: 1024,
  POLICE: 4096
} as const;

export interface SoopPacket {
  serviceCode: number;
  retCode: number;
  packet: string[];
  raw: Uint8Array;
}

export function parseSoopPacket(data: ArrayBuffer | ArrayBufferView | string): SoopPacket | undefined {
  const bytes = coerceBytes(data);
  if (!bytes || bytes.byteLength < 14) {
    return undefined;
  }

  if (bytes[0] !== ESCAPE || bytes[1] !== TAB) {
    return undefined;
  }

  const serviceCode = readAsciiNumber(bytes.slice(2, 6));
  const declaredBodyLength = readAsciiNumber(bytes.slice(6, 12));
  const retCode = readAsciiNumber(bytes.slice(12, 14));
  const bodyEnd = declaredBodyLength > 0 ? Math.min(14 + declaredBodyLength, bytes.byteLength) : bytes.byteLength;
  const body = bytes.slice(14, bodyEnd);

  return {
    serviceCode,
    retCode,
    packet: readFields(body),
    raw: bytes
  };
}

export function normalizeSoopChatPacket(packet: SoopPacket, channelId: string): ChatMessage | undefined {
  if (packet.serviceCode !== SOOP_SERVICE.CHAT_MESSAGE || packet.retCode !== 0) {
    return undefined;
  }

  const content = (packet.packet[0] ?? "").replace(/\r/gi, "");
  if (!content.trim()) {
    return undefined;
  }

  const senderId = packet.packet[1] ?? "";
  const nickname = packet.packet[5]?.trim() || senderId || "익명";
  const flag = readFlag(packet.packet[6]);
  const subscriptionMonth = Number(packet.packet[7] ?? 0);
  const role = resolveRole(flag, subscriptionMonth);
  const timestamp = Date.now();

  return {
    provider: "soop",
    sourceMode: "unofficial",
    channelId,
    messageId: buildMessageId(channelId, senderId, timestamp, content),
    nickname,
    role,
    badges: buildBadges(flag, subscriptionMonth),
    content,
    emotes: [],
    timestamp,
    raw: {
      serviceCode: packet.serviceCode,
      retCode: packet.retCode,
      packet: packet.packet
    }
  };
}

function coerceBytes(data: ArrayBuffer | ArrayBufferView | string) {
  if (typeof data === "string") {
    return Uint8Array.from(Array.from(data, (char) => char.charCodeAt(0) & 0xff));
  }

  if (data instanceof ArrayBuffer) {
    return new Uint8Array(data);
  }

  if (ArrayBuffer.isView(data)) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  }

  return undefined;
}

function readAsciiNumber(bytes: Uint8Array) {
  const text = String.fromCharCode(...bytes);
  const value = Number(text);
  return Number.isFinite(value) ? value : 0;
}

function readFields(bytes: Uint8Array) {
  const fields: string[] = [];
  let current: number[] = [];
  const start = bytes[0] === FIELD_SEPARATOR ? 1 : 0;

  for (let index = start; index < bytes.byteLength; index += 1) {
    const byte = bytes[index];
    if (byte === FIELD_SEPARATOR) {
      fields.push(decodeField(current));
      current = [];
      continue;
    }
    current.push(byte);
  }

  if (current.length > 0) {
    fields.push(decodeField(current));
  }

  return fields;
}

function decodeField(bytes: number[]) {
  if (bytes.length === 0) {
    return "";
  }
  return new TextDecoder().decode(Uint8Array.from(bytes));
}

function readFlag(input: string | undefined) {
  const flag = Number(input ?? 0);
  return Number.isFinite(flag) ? flag : 0;
}

function resolveRole(flag: number, subscriptionMonth: number): ChatRole {
  if (hasFlag(flag, SOOP_FLAG.BJ)) {
    return "streamer";
  }

  if (hasFlag(flag, SOOP_FLAG.MANAGER) || hasFlag(flag, SOOP_FLAG.MANAGERLIST)) {
    return "manager";
  }

  if (hasFlag(flag, SOOP_FLAG.ADMIN) || hasFlag(flag, SOOP_FLAG.EMPLOYEE) || hasFlag(flag, SOOP_FLAG.POLICE)) {
    return "verified";
  }

  if (subscriptionMonth > 0 || hasFlag(flag, SOOP_FLAG.FANCLUB)) {
    return "subscriber";
  }

  return "viewer";
}

function buildBadges(flag: number, subscriptionMonth: number) {
  const badges: ChatBadge[] = [];

  if (hasFlag(flag, SOOP_FLAG.BJ)) {
    badges.push({ id: "soop-bj", label: "BJ" });
  }

  if (hasFlag(flag, SOOP_FLAG.MANAGER) || hasFlag(flag, SOOP_FLAG.MANAGERLIST)) {
    badges.push({ id: "soop-manager", label: "매니저" });
  }

  if (subscriptionMonth > 0) {
    badges.push({ id: "soop-subscription", label: `${subscriptionMonth}개월` });
  } else if (hasFlag(flag, SOOP_FLAG.FANCLUB)) {
    badges.push({ id: "soop-fanclub", label: "팬클럽" });
  }

  if (hasFlag(flag, SOOP_FLAG.GUEST)) {
    badges.push({ id: "soop-guest", label: "게스트" });
  }

  return badges;
}

function hasFlag(flag: number, mask: number) {
  return Math.floor(flag / mask) % 2 === 1;
}

function buildMessageId(channelId: string, senderId: string, timestamp: number, content: string) {
  const seed = `soop:${channelId}:${senderId}:${timestamp}:${content}`;
  let hash = 0;
  for (let index = 0; index < seed.length; index += 1) {
    hash = (hash << 5) - hash + seed.charCodeAt(index);
    hash |= 0;
  }
  return `soop-${Math.abs(hash).toString(36)}`;
}
