import type { ChatBadge, ChatEmote, ChatMessage, ChatRole, SourceMode } from "../../shared/types";

interface OfficialChzzkChatEvent {
  channelId?: string;
  senderChannelId?: string;
  profile?: {
    nickname?: string;
    badges?: unknown[];
    verifiedMark?: boolean;
    userRoleCode?: string;
  };
  content?: string;
  emojis?: Record<string, string>;
  messageTime?: number;
}

interface UnofficialChatBody {
  cid?: string;
  uid?: string;
  profile?: string | Record<string, unknown>;
  msg?: string;
  extras?: string | Record<string, unknown>;
  msgTime?: number;
  mbrCnt?: number;
}

const roleMap: Record<string, ChatRole> = {
  streamer: "streamer",
  streaming_channel_manager: "manager",
  streaming_chat_manager: "chat_manager",
  common_user: "viewer"
};

export function normalizeOfficialChzzkChatEvent(raw: OfficialChzzkChatEvent): ChatMessage {
  const profile = raw.profile ?? {};
  const role = resolveRole(profile.userRoleCode, profile.verifiedMark);
  const content = raw.content ?? "";
  const channelId = raw.channelId ?? "";

  return {
    provider: "chzzk",
    sourceMode: "official",
    channelId,
    messageId: buildMessageId("official", channelId, raw.senderChannelId, raw.messageTime, content),
    nickname: profile.nickname?.trim() || "익명",
    role,
    badges: normalizeOfficialBadges(profile.badges, profile.verifiedMark),
    content,
    emotes: normalizeEmoteMap(raw.emojis),
    timestamp: raw.messageTime ?? Date.now(),
    raw
  };
}

export function normalizeUnofficialChzzkChatEvent(
  raw: UnofficialChatBody,
  fallbackChannelId: string
): ChatMessage {
  const profile = parseLooseJson(raw.profile);
  const extras = parseLooseJson(raw.extras);
  const nickname =
    readString(profile, "nickname") ||
    readString(profile, "nickName") ||
    readString(profile, "name") ||
    "익명";
  const role = resolveUnofficialRole(profile, extras);
  const content = raw.msg ?? "";
  const channelId = raw.cid ?? fallbackChannelId;

  return {
    provider: "chzzk",
    sourceMode: "unofficial",
    channelId,
    messageId: buildMessageId("unofficial", channelId, raw.uid, raw.msgTime, content),
    nickname,
    role,
    badges: normalizeUnofficialBadges(profile),
    content,
    emotes: normalizeEmoteMap(readRecord(extras, "emojis") ?? readRecord(extras, "emotes")),
    timestamp: raw.msgTime ?? Date.now(),
    raw
  };
}

function resolveRole(userRoleCode?: string, verifiedMark?: boolean): ChatRole {
  if (userRoleCode && roleMap[userRoleCode]) {
    return roleMap[userRoleCode];
  }

  return verifiedMark ? "verified" : "viewer";
}

function resolveUnofficialRole(profile: Record<string, unknown>, extras: Record<string, unknown>): ChatRole {
  const userRoleCode =
    readString(profile, "userRoleCode") ||
    readString(profile, "roleCode") ||
    readString(extras, "userRoleCode");

  return resolveRole(userRoleCode, Boolean(profile.verifiedMark));
}

function normalizeOfficialBadges(input: unknown, verifiedMark?: boolean): ChatBadge[] {
  const badges: ChatBadge[] = [];
  if (verifiedMark) {
    badges.push({ id: "verified", label: "인증" });
  }

  if (!Array.isArray(input)) {
    return badges;
  }

  for (const item of input) {
    if (typeof item === "string") {
      badges.push({ id: item, label: item });
      continue;
    }

    if (item && typeof item === "object") {
      const record = item as Record<string, unknown>;
      const id = readString(record, "id") || readString(record, "badgeNo") || readString(record, "type");
      const label = readString(record, "label") || readString(record, "name") || id;
      const imageUrl = readString(record, "imageUrl") || readString(record, "url");
      if (id || label) {
        const badgeId = id ?? label ?? "badge";
        badges.push({ id: badgeId, label: label ?? badgeId, imageUrl });
      }
    }
  }

  return badges;
}

function normalizeUnofficialBadges(profile: Record<string, unknown>): ChatBadge[] {
  const badges = normalizeOfficialBadges(profile.badges ?? profile.badge, Boolean(profile.verifiedMark));
  const subscription = readString(profile, "subscriptionBadge");
  if (subscription) {
    badges.push({ id: "subscription", label: subscription });
  }
  return badges;
}

function normalizeEmoteMap(input: unknown): ChatEmote[] {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return [];
  }

  return Object.entries(input as Record<string, unknown>)
    .filter(([, value]) => typeof value === "string" && value.length > 0)
    .map(([token, url]) => ({
      id: token,
      token,
      url: url as string
    }));
}

function buildMessageId(
  sourceMode: SourceMode,
  channelId?: string,
  senderId?: string,
  timestamp?: number,
  content?: string
) {
  const seed = `${sourceMode}:${channelId ?? ""}:${senderId ?? ""}:${timestamp ?? Date.now()}:${content ?? ""}`;
  let hash = 0;
  for (let index = 0; index < seed.length; index += 1) {
    hash = (hash << 5) - hash + seed.charCodeAt(index);
    hash |= 0;
  }
  return `${sourceMode}-${Math.abs(hash).toString(36)}`;
}

function parseLooseJson(input: unknown): Record<string, unknown> {
  if (!input) {
    return {};
  }

  if (typeof input === "object" && !Array.isArray(input)) {
    return input as Record<string, unknown>;
  }

  if (typeof input !== "string") {
    return {};
  }

  try {
    const parsed = JSON.parse(input);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function readString(record: Record<string, unknown>, key: string) {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

function readRecord(record: Record<string, unknown>, key: string) {
  const value = record[key];
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, string>)
    : undefined;
}
