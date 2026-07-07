import type { ChatMessage, ChatProvider, ConnectProviderRequest, ProviderStatus } from "../../shared/types";

export interface ProviderCallbacks {
  onMessage(message: ChatMessage): void;
  onStatus(status: ProviderStatus): void;
  onViewerCount?(provider: ChatProvider, count: number): void;
}

export interface ProviderAdapter {
  readonly provider: ChatProvider;
  readonly sourceMode: ConnectProviderRequest["sourceMode"];
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  getStatus(): ProviderStatus;
}

export interface ChzzkTokenSet {
  accessToken: string;
  refreshToken?: string;
  tokenType: "Bearer" | string;
  expiresAt: number;
  scope?: string;
}
