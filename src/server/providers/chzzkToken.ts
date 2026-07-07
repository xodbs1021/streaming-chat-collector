import type { ChzzkTokenSet } from "./types";

interface ChzzkTokenPayload {
  accessToken?: string;
  refreshToken?: string;
  tokenType?: string;
  expiresIn?: string | number;
  scope?: string;
}

export function parseChzzkTokenResponse(payload: unknown, fallbackRefreshToken?: string): ChzzkTokenSet | undefined {
  if (!payload || typeof payload !== "object") {
    return undefined;
  }

  const record = payload as Record<string, unknown>;
  const content = record.content && typeof record.content === "object"
    ? (record.content as ChzzkTokenPayload)
    : (record as ChzzkTokenPayload);

  if (!content.accessToken) {
    return undefined;
  }

  return {
    accessToken: content.accessToken,
    refreshToken: content.refreshToken ?? fallbackRefreshToken,
    tokenType: content.tokenType ?? "Bearer",
    expiresAt: Date.now() + Number(content.expiresIn ?? 86_400) * 1000,
    scope: content.scope
  };
}
