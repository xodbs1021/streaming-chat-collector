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

export const CHZZK_OPEN_API_BASE = "https://openapi.chzzk.naver.com";
export const CHZZK_ACCOUNT_INTERLOCK_URL = "https://chzzk.naver.com/account-interlock";
export const CHZZK_HOME_URL = "https://chzzk.naver.com/";
export const NAVER_LOGIN_URL = "https://nid.naver.com/nidlogin.login";
