import type { ChatProvider, LiveOffsetStatus, OffsetEstimatorParams } from "../../shared/types";
import { CONFIDENT_THRESHOLD, DEFAULT_ESTIMATOR_PARAMS, estimateWindowOffset } from "./offsetEstimator";

export interface LiveOffsetTrackerDeps {
  params?: OffsetEstimatorParams;
  clock?: () => number;
  /** offset 싱크 on/off(OFFSET_SYNC). 배지 표시용 — 꺼져 있으면 "보정 꺼짐". */
  enabled?: boolean;
}

/** 재추정 결과를 applied 축으로 채택하는 최소 변화(ms). 이보다 작은 흔들림은 축을 흔들지 않는다. */
const RETIME_THRESHOLD_MS = 2_000;

/**
 * 라이브 방송 중 SOOP↔치지직 offset을 메모리에서 추적한다(디스크는 손대지 않음 — finalize가 파일 정렬 담당).
 * observe는 실시간 경로라 O(1)(초 관측만 push), 재추정은 60초 타이머가 부르는 무거운 상관 계산이다.
 *
 * **축 일관성:** correct()가 실제로 쓰는 축은 `appliedOffsetMs` 하나다. 재추정이 새 값을 내도, 그 값을 applied로
 * 채택(=retime 동반)할 때만 축을 옮긴다(첫 신뢰 또는 |estimate − applied| > 2초). 2초 미만 흔들림은 applied를
 * 유지해 새/옛 메시지가 다른 축으로 갈라지지 않게 하고, 남는 오차는 finalize가 파일 정렬에서 정리한다.
 * 부호 규약(anchorTime = soopTime + offsetMs)은 finalize·shared/offset과 동일.
 */
export class LiveOffsetTracker {
  private chzzkTimes: number[] = [];
  private soopTimes: number[] = [];
  private appliedOffsetMs = 0;
  private confidence = 0;
  private hasConfident = false;
  private readonly params: OffsetEstimatorParams;
  private readonly clock: () => number;
  private readonly enabled: boolean;

  constructor(deps: LiveOffsetTrackerDeps = {}) {
    this.params = deps.params ?? DEFAULT_ESTIMATOR_PARAMS;
    this.clock = deps.clock ?? Date.now;
    this.enabled = deps.enabled ?? true;
  }

  /** 실시간 경로(O(1)) — 관측 시각만 쌓는다. 무거운 계산은 reestimate로 미룬다. */
  observe(provider: ChatProvider, timestamp: number): void {
    (provider === "chzzk" ? this.chzzkTimes : this.soopTimes).push(timestamp);
  }

  /** SOOP 레코드의 라이브 표시용 anchor 축 timestamp. 치지직은 anchor라 그대로. 실제 쓰는 축은 applied. */
  correct(provider: ChatProvider, timestamp: number): number {
    return provider === "soop" ? timestamp + this.appliedOffsetMs : timestamp;
  }

  /** 현재 적용(표시) 중인 offset(ms). 아직 신뢰 추정이 없으면 undefined. */
  currentOffsetMs(): number | undefined {
    return this.hasConfident ? this.appliedOffsetMs : undefined;
  }

  /**
   * 60초 주기 재추정 — 최근 windowSec 데이터로 offset을 다시 계산한다.
   * 새 추정을 applied로 채택(retime 동반)할 때만 { deltaMs, firstConfident }를 반환한다.
   * 첫 신뢰거나 |estimate − applied| > 2초일 때만 채택 — 그 외(저신뢰·sub-2초 흔들림)는 undefined.
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
    this.confidence = estimate.confidence;

    const firstConfident = !this.hasConfident;
    const previousApplied = this.hasConfident ? this.appliedOffsetMs : 0;
    const delta = estimate.offsetMs - previousApplied;
    // sub-2초 흔들림은 채택하지 않는다(축 일관 유지) — 첫 신뢰만 예외로 무조건 채택.
    if (!firstConfident && Math.abs(delta) <= RETIME_THRESHOLD_MS) {
      return undefined;
    }
    this.appliedOffsetMs = estimate.offsetMs;
    this.hasConfident = true;
    return { deltaMs: delta, firstConfident };
  }

  /** 라이브 배지(offset:live)용 상태 페이로드. */
  getStatus(): LiveOffsetStatus {
    return {
      enabled: this.enabled,
      offsetMs: this.hasConfident ? this.appliedOffsetMs : undefined,
      confidence: this.hasConfident ? this.confidence : undefined,
      estimating: !this.hasConfident,
      segmentCount: this.hasConfident ? 1 : 0,
      carriedCount: 0
    };
  }

  reset(): void {
    this.chzzkTimes = [];
    this.soopTimes = [];
    this.appliedOffsetMs = 0;
    this.confidence = 0;
    this.hasConfident = false;
  }
}
