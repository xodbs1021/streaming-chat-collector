/**
 * 스트림에서 순서대로 도착한 프레임에 "진짜 초"(기준 벽시계 + 스트림 내 순번)를
 * 부여하고, 재접속 경계의 짧은 공백을 직전 프레임 복제로 메우는 순수 정책기.
 *
 * ffmpeg/fs에 의존하지 않는 완전 결정론적 모듈이다. 입력은 "프레임당 앵커 초(nowSec)"
 * 이며, 앵커 소스를 순번 → PTS로 교체해도 이 계약은 불변이다.
 */

/** 재접속 공백을 직전 프레임 복제로 메우는 최대 초. 초과하면 실제 콘텐츠 공백으로 보고 비운다. */
export const SHORT_GAP_MAX_SEC = 3;

export interface FrameAssignment {
  /** 이 프레임을 저장할 에폭 초 파일명. */
  second: number;
  /** 짧은 공백을 메우기 위해 직전 프레임을 복제 저장할 초들(비었으면 갭필 없음). */
  fills: number[];
}

export class FrameSecondAssigner {
  // 현재 spawn의 첫 프레임 초 기준점. undefined면 다음 프레임이 새 spawn의 첫 프레임.
  private baseEpochSec: number | undefined;
  private ordinal = 0;
  // 갭필용으로 spawn 경계를 넘어 유지되는 마지막 실 프레임 상태.
  private lastFrameSec: number | undefined;
  private lastFrameBuffer: Buffer | undefined;

  /**
   * 도착한 프레임에 초를 배정한다.
   * @param nowSec 도착 앵커 초(벽시계). spawn 내 순번이 실제 파일명을 몰아가며, nowSec은 spawn 첫 프레임 앵커에만 쓰인다.
   * @param frame 도착 프레임 바이트(갭필 복제 소스로 보관).
   */
  assign(nowSec: number, frame: Buffer): FrameAssignment {
    const isFirstOfSpawn = this.baseEpochSec === undefined;
    if (isFirstOfSpawn) {
      // 단조 보장 — 스윕/이전 spawn이 이미 쓴 초를 부활시키지 않도록 lastFrameSec+1로 바닥을 깐다.
      const floor = (this.lastFrameSec ?? Number.NEGATIVE_INFINITY) + 1;
      this.baseEpochSec = Math.max(nowSec, floor);
      this.ordinal = 0;
    }
    const base = this.baseEpochSec as number;
    const second = base + this.ordinal;
    this.ordinal += 1;

    const fills = isFirstOfSpawn ? this.computeGapFills(second) : [];

    this.lastFrameSec = second;
    this.lastFrameBuffer = frame;
    return { second, fills };
  }

  /** 갭필 복제 소스가 될 직전 실 프레임 버퍼(첫 프레임 배정 전에 조회). */
  getLastFrameBuffer(): Buffer | undefined {
    return this.lastFrameBuffer;
  }

  /**
   * spawn 경계 리셋: 순번·기준점만 초기화한다.
   * lastFrameSec/lastFrameBuffer는 재접속 갭필을 위해 의도적으로 유지한다.
   */
  resetSpawn(): void {
    this.baseEpochSec = undefined;
    this.ordinal = 0;
  }

  /** 재접속 첫 프레임 한정: 직전 초와의 짧은 공백을 메울 초 목록을 만든다. */
  private computeGapFills(second: number): number[] {
    if (this.lastFrameSec === undefined) {
      return [];
    }
    const gap = second - (this.lastFrameSec + 1);
    if (gap <= 0 || gap > SHORT_GAP_MAX_SEC) {
      return [];
    }
    const fills: number[] = [];
    for (let sec = this.lastFrameSec + 1; sec <= second - 1; sec += 1) {
      fills.push(sec);
    }
    return fills;
  }
}
