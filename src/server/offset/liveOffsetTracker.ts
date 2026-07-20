import type { ChatProvider, LiveOffsetStatus, OffsetEstimatorParams } from "../../shared/types";
import { CONFIDENT_THRESHOLD, DEFAULT_ESTIMATOR_PARAMS, estimateWindowOffset } from "./offsetEstimator";

export interface LiveOffsetTrackerDeps {
  params?: OffsetEstimatorParams;
  clock?: () => number;
}

/**
 * 라이브 방송 중 SOOP↔치지직 offset을 메모리에서 추적한다(디스크는 손대지 않음 — finalize가 파일 정렬 담당).
 * observe는 실시간 경로라 O(1)(초 관측만 push), 재추정은 60초 타이머가 부르는 무거운 상관 계산이다.
 * 부호 규약(anchorTime = soopTime + offsetMs)은 finalize·shared/offset과 동일.
 */
export class LiveOffsetTracker {
  private chzzkTimes: number[] = [];
  private soopTimes: number[] = [];
  private offsetMs = 0;
  private confidence = 0;
  private hasConfident = false;
  private readonly params: OffsetEstimatorParams;
  private readonly clock: () => number;

  constructor(deps: LiveOffsetTrackerDeps = {}) {
    this.params = deps.params ?? DEFAULT_ESTIMATOR_PARAMS;
    this.clock = deps.clock ?? Date.now;
  }

  /** 실시간 경로(O(1)) — 관측 시각만 쌓는다. 무거운 계산은 reestimate로 미룬다. */
  observe(provider: ChatProvider, timestamp: number): void {
    (provider === "chzzk" ? this.chzzkTimes : this.soopTimes).push(timestamp);
  }

  /** SOOP 레코드의 라이브 표시용 anchor 축 timestamp. 치지직은 anchor라 그대로. 추정 전이면 offset 0. */
  correct(provider: ChatProvider, timestamp: number): number {
    return provider === "soop" ? timestamp + this.offsetMs : timestamp;
  }

  /** 현재 적용 중인 offset(ms). 아직 신뢰 추정이 없으면 undefined. */
  currentOffsetMs(): number | undefined {
    return this.hasConfident ? this.offsetMs : undefined;
  }

  /**
   * 60초 주기 재추정 — 최근 windowSec 데이터로 offset을 다시 계산한다.
   * @returns 신뢰 추정이 나오면 { deltaMs: 직전 대비 변화, firstConfident }, 아니면 undefined(변화 없음).
   */
  reestimate(): { deltaMs: number; firstConfident: boolean } | undefined {
    const now = this.clock();
    const windowMs = this.params.windowSec * 1000;
    const windowStart = now - windowMs;
    // 창 밖 오래된 관측은 버려 메모리를 windowSec로 묶는다(재추정 시점에만 정리 — observe는 O(1) 유지).
    this.chzzkTimes = this.chzzkTimes.filter((time) => time >= windowStart);
    this.soopTimes = this.soopTimes.filter((time) => time >= windowStart);

    const estimate = estimateWindowOffset(this.chzzkTimes, this.soopTimes, windowStart, now, this.params);
    if (!estimate || estimate.confidence < CONFIDENT_THRESHOLD) {
      return undefined;
    }

    const previousOffset = this.hasConfident ? this.offsetMs : 0;
    const firstConfident = !this.hasConfident;
    this.offsetMs = estimate.offsetMs;
    this.confidence = estimate.confidence;
    this.hasConfident = true;
    return { deltaMs: estimate.offsetMs - previousOffset, firstConfident };
  }

  /** 라이브 배지(offset:live)용 상태 페이로드. */
  getStatus(): LiveOffsetStatus {
    return {
      offsetMs: this.hasConfident ? this.offsetMs : undefined,
      confidence: this.hasConfident ? this.confidence : undefined,
      estimating: !this.hasConfident,
      segmentCount: this.hasConfident ? 1 : 0,
      carriedCount: 0
    };
  }

  reset(): void {
    this.chzzkTimes = [];
    this.soopTimes = [];
    this.offsetMs = 0;
    this.confidence = 0;
    this.hasConfident = false;
  }
}
