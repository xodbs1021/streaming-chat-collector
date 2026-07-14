import path from "node:path";
import type { ChatProvider } from "../../shared/types";

/**
 * 방송 세션 레이아웃의 파일 경로 단일 진실원.
 * `<root>/<broadcastId>/broadcast.meta.json` +
 * `<root>/<broadcastId>/chat/<provider>/{chat.jsonl,meta.json,viewers.jsonl,markers.json,highlights.json}`.
 * 경로 규칙을 한 곳에 모아, 레이아웃이 바뀌어도 이 클래스만 고치면 되게 한다.
 */
export class BroadcastPaths {
  constructor(private readonly root: string) {}

  broadcastDir(broadcastId: string): string {
    return path.join(this.root, broadcastId);
  }

  broadcastMetaPath(broadcastId: string): string {
    return path.join(this.broadcastDir(broadcastId), "broadcast.meta.json");
  }

  chatDir(broadcastId: string, provider: ChatProvider): string {
    return path.join(this.broadcastDir(broadcastId), "chat", provider);
  }

  chatFilePath(broadcastId: string, provider: ChatProvider): string {
    return path.join(this.chatDir(broadcastId, provider), "chat.jsonl");
  }

  metaFilePath(broadcastId: string, provider: ChatProvider): string {
    return path.join(this.chatDir(broadcastId, provider), "meta.json");
  }

  viewersFilePath(broadcastId: string, provider: ChatProvider): string {
    return path.join(this.chatDir(broadcastId, provider), "viewers.jsonl");
  }

  markersFilePath(broadcastId: string, provider: ChatProvider): string {
    return path.join(this.chatDir(broadcastId, provider), "markers.json");
  }

  highlightsFilePath(broadcastId: string, provider: ChatProvider): string {
    return path.join(this.chatDir(broadcastId, provider), "highlights.json");
  }
}
