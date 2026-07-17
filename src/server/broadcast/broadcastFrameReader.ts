import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import type { ChatProvider } from "../../shared/types";
import { nearestFrameSecond } from "../../shared/frameSeconds";
import { isValidBroadcastId } from "./broadcastId";
import { BroadcastPaths } from "./broadcastPaths";

/** `<epoch초>.jpg` 형태의 캡처 프레임 파일만 인덱스에 넣는다. */
const FRAME_FILE_PATTERN = /^\d+\.jpg$/;

/**
 * 저장된 방송의 프레임 폴더를 디스크에서 읽는다 (라이브 캡처와 무관한 읽기 전용 부품).
 * 과거 방송은 불변이므로 폴더 mtime 키 캐시로 반복 폴링을 O(stat 1회)로 만든다 —
 * mtime이 그대로면 캐시를 반환하고, 바뀌면 readdir로 재구축, 폴더가 사라지면(ENOENT)
 * 엔트리를 지우고 빈 결과를 준다(자기 치유 — 교차 모듈 캐시 무효화 배선이 필요 없다).
 */
export class BroadcastFrameReader {
  private readonly cache = new Map<string, { mtimeMs: number; seconds: number[] }>();

  constructor(private readonly paths: BroadcastPaths) {}

  /** [from, to] 구간의 캡처 프레임 초 목록(오름차순). 폴더 없음/형식 불량 broadcastId → []. */
  async listFrameSeconds(broadcastId: string, provider: ChatProvider, from: number, to: number): Promise<number[]> {
    const seconds = await this.readAllSeconds(broadcastId, provider);
    return seconds.filter((second) => second >= from && second <= to);
  }

  /** second 이하 최근접(공유 tolerance 15초) 프레임 파일 경로. 없으면 undefined. */
  async nearestFramePath(broadcastId: string, provider: ChatProvider, second: number): Promise<string | undefined> {
    const seconds = await this.readAllSeconds(broadcastId, provider);
    const match = nearestFrameSecond(seconds, second);
    if (match === undefined) {
      return undefined;
    }
    return path.join(this.paths.frameDir(broadcastId, provider), `${match}.jpg`);
  }

  /** 형식 불량 id는 경로 조립 없이 무결과(라우트 400과 별개의 이중 방어). 나머지는 mtime 키 캐시 경유. */
  private async readAllSeconds(broadcastId: string, provider: ChatProvider): Promise<number[]> {
    if (!isValidBroadcastId(broadcastId)) {
      return [];
    }
    const frameDir = this.paths.frameDir(broadcastId, provider);
    let dirStat;
    try {
      dirStat = await stat(frameDir);
    } catch {
      this.cache.delete(frameDir);
      return [];
    }
    const cached = this.cache.get(frameDir);
    if (cached && cached.mtimeMs === dirStat.mtimeMs) {
      return cached.seconds;
    }
    const entries = await readdir(frameDir);
    const seconds = entries
      .filter((name) => FRAME_FILE_PATTERN.test(name))
      .map((name) => Number.parseInt(name, 10))
      .sort((left, right) => left - right);
    this.cache.set(frameDir, { mtimeMs: dirStat.mtimeMs, seconds });
    return seconds;
  }
}
