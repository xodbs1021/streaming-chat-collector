import dotenv from "dotenv";

dotenv.config();

export interface AppConfig {
  port: number;
  host: string;
  publicBaseUrl: string;
  frontendOrigin: string;
  chzzkClientId?: string;
  chzzkClientSecret?: string;
  chzzkRedirectUri: string;
  defaultChannelId?: string;
  soopDefaultChannelId?: string;
  chatDataDir: string;
}

const port = Number(process.env.PORT ?? 4010);
const publicBaseUrl = process.env.PUBLIC_BASE_URL ?? `http://localhost:${port}`;

export const config: AppConfig = {
  port,
  host: process.env.HOST ?? "127.0.0.1",
  publicBaseUrl,
  frontendOrigin: process.env.FRONTEND_ORIGIN ?? publicBaseUrl,
  chzzkClientId: process.env.CHZZK_CLIENT_ID,
  chzzkClientSecret: process.env.CHZZK_CLIENT_SECRET,
  chzzkRedirectUri:
    process.env.CHZZK_REDIRECT_URI ?? `${publicBaseUrl}/api/auth/chzzk/callback`,
  defaultChannelId: process.env.CHZZK_DEFAULT_CHANNEL_ID,
  soopDefaultChannelId: process.env.SOOP_DEFAULT_CHANNEL_ID,
  chatDataDir: process.env.CHAT_DATA_DIR ?? "./data/chat-sessions"
};

/**
 * 방송 종료(모든 provider offline) 감지 후 자동으로 녹화를 종료하기까지의 유예 시간.
 * 짧은 끊김/재접속에 세션이 둘로 쪼개지지 않도록 이 시간만큼 기다렸다가 확정한다.
 */
export const RECORD_GRACE_MS = 3 * 60_000;

export const CHZZK_OPEN_API_BASE = "https://openapi.chzzk.naver.com";
export const CHZZK_ACCOUNT_INTERLOCK_URL = "https://chzzk.naver.com/account-interlock";
export const CHZZK_HOME_URL = "https://chzzk.naver.com/";
export const NAVER_LOGIN_URL = "https://nid.naver.com/nidlogin.login";
