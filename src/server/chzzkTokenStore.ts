import path from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import type { ChzzkTokenSet } from "./providers/types";

// 발급받은 치지직 토큰을 디스크에 보관/복원한다. 서버 시작 시 복원, 갱신 시 저장.
export async function readStoredChzzkToken(tokenPath: string) {
  try {
    const content = await readFile(tokenPath, "utf8");
    const parsed = JSON.parse(content) as Partial<ChzzkTokenSet>;
    if (!parsed.accessToken) {
      return undefined;
    }
    return {
      accessToken: parsed.accessToken,
      refreshToken: parsed.refreshToken,
      tokenType: parsed.tokenType ?? "Bearer",
      expiresAt: Number(parsed.expiresAt ?? 0),
      scope: parsed.scope
    };
  } catch {
    return undefined;
  }
}

export async function persistChzzkToken(tokenPath: string, token: ChzzkTokenSet | undefined) {
  if (!token) {
    return;
  }
  await mkdir(path.dirname(tokenPath), { recursive: true });
  await writeFile(tokenPath, `${JSON.stringify(token, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
}
