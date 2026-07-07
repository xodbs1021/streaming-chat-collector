import type { FastifyInstance, FastifyReply } from "fastify";
import { randomBytes } from "node:crypto";
import {
  CHZZK_ACCOUNT_INTERLOCK_URL,
  CHZZK_HOME_URL,
  CHZZK_OPEN_API_BASE,
  NAVER_LOGIN_URL,
  config
} from "../config";
import { parseChzzkTokenResponse } from "../providers/chzzkToken";
import type { ChzzkTokenSet } from "../providers/types";
import { AppState } from "../state";

interface AuthRouteDeps {
  state: AppState;
  getChzzkToken: () => ChzzkTokenSet | undefined;
  setChzzkToken: (token: ChzzkTokenSet) => Promise<void>;
}

const OAUTH_STATE_TTL_MS = 600_000;

export function registerAuthRoutes(app: FastifyInstance, deps: AuthRouteDeps) {
  const { state, getChzzkToken, setChzzkToken } = deps;
  const oauthStates = new Map<string, number>();

  function pruneOauthStates() {
    const cutoff = Date.now() - OAUTH_STATE_TTL_MS;
    for (const [value, createdAt] of oauthStates) {
      if (createdAt < cutoff) {
        oauthStates.delete(value);
      }
    }
  }

  function takeOauthState(value: string) {
    pruneOauthStates();
    const createdAt = oauthStates.get(value);
    if (createdAt === undefined) {
      return false;
    }
    oauthStates.delete(value);
    return true;
  }

  app.get("/api/auth/chzzk/login", async (_request, reply) => {
    const naverLoginUrl = new URL(NAVER_LOGIN_URL);
    naverLoginUrl.searchParams.set("mode", "form");
    naverLoginUrl.searchParams.set("url", CHZZK_HOME_URL);

    return reply.redirect(naverLoginUrl.toString());
  });

  app.get<{ Querystring: { viaNaver?: string } }>("/api/auth/chzzk/start", async (request, reply) => {
    if (!config.chzzkClientId) {
      return reply.code(400).send({
        error: "CHZZK_CLIENT_ID가 .env에 없습니다.",
        hint: ".env.example을 복사해 치지직 Developers 앱 정보를 입력하세요."
      });
    }

    const oauthState = randomBytes(18).toString("base64url");
    pruneOauthStates();
    oauthStates.set(oauthState, Date.now());

    const url = new URL(CHZZK_ACCOUNT_INTERLOCK_URL);
    url.searchParams.set("clientId", config.chzzkClientId);
    url.searchParams.set("redirectUri", config.chzzkRedirectUri);
    url.searchParams.set("state", oauthState);

    if (request.query.viaNaver === "1") {
      const naverLoginUrl = new URL(NAVER_LOGIN_URL);
      naverLoginUrl.searchParams.set("mode", "form");
      naverLoginUrl.searchParams.set("url", url.toString());
      return reply.redirect(naverLoginUrl.toString());
    }

    return reply.redirect(url.toString());
  });

  app.get<{ Querystring: { code?: string; state?: string; error?: string; error_description?: string } }>("/api/auth/chzzk/callback", async (request, reply) => {
    const { code, state: returnedState, error, error_description } = request.query;
    if (error) {
      const message = error_description || error;
      state.setStatus({
        provider: "chzzk",
        sourceMode: "official",
        state: "error",
        message: `치지직 공식 로그인이 취소되었거나 실패했습니다: ${message}`
      });
      return redirectAdmin(reply, "error", message);
    }

    if (!code || !returnedState || !takeOauthState(returnedState)) {
      const message = "치지직 OAuth callback state가 올바르지 않습니다. 로그인 버튼을 다시 눌러주세요.";
      state.setStatus({
        provider: "chzzk",
        sourceMode: "official",
        state: "error",
        message
      });
      return redirectAdmin(reply, "error", message);
    }

    try {
      const token = await exchangeAuthorizationCode(code, returnedState);
      await setChzzkToken(token);
      state.setStatus({
        provider: "chzzk",
        sourceMode: "official",
        state: "idle",
        message: "치지직 공식 로그인이 완료되었습니다. 관리 화면에서 연결을 누르세요."
      });
      return redirectAdmin(reply, "ok");
    } catch (error) {
      const message = error instanceof Error ? error.message : "치지직 토큰 발급 실패";
      app.log.error(error);
      state.setStatus({
        provider: "chzzk",
        sourceMode: "official",
        state: "error",
        message
      });
      return redirectAdmin(reply, "error", message);
    }
  });

  app.get("/api/auth/chzzk/status", async () => ({
    configured: Boolean(config.chzzkClientId && config.chzzkClientSecret),
    hasToken: Boolean(getChzzkToken()),
    redirectUri: config.chzzkRedirectUri,
    frontendOrigin: config.frontendOrigin,
    chzzkHomeUrl: CHZZK_HOME_URL
  }));
}

async function exchangeAuthorizationCode(code: string, oauthState: string): Promise<ChzzkTokenSet> {
  if (!config.chzzkClientId || !config.chzzkClientSecret) {
    throw new Error("CHZZK_CLIENT_ID 또는 CHZZK_CLIENT_SECRET이 없습니다.");
  }

  const response = await fetch(`${CHZZK_OPEN_API_BASE}/auth/v1/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grantType: "authorization_code",
      clientId: config.chzzkClientId,
      clientSecret: config.chzzkClientSecret,
      code,
      state: oauthState
    })
  });

  if (!response.ok) {
    throw new Error(`치지직 토큰 발급 실패 (${response.status})`);
  }

  const token = parseChzzkTokenResponse(await response.json());
  if (!token) {
    throw new Error("치지직 토큰 응답에 accessToken이 없습니다.");
  }

  return token;
}

function redirectAdmin(reply: FastifyReply, status: "ok" | "error", message?: string) {
  const url = new URL("/admin", config.frontendOrigin);
  url.searchParams.set("auth", "chzzk");
  url.searchParams.set("status", status);
  if (message) {
    url.searchParams.set("message", message);
  }
  return reply.redirect(url.toString());
}
