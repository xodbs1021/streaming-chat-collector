/**
 * 방송 종료(모든 provider offline) 감지 후 자동 녹화 종료까지의 단발 유예 타이머.
 * schedule()로 예약하고, provider가 다시 붙으면 cancel()로 취소, 만료되면 onExpire를 1회 호출한다.
 * 연결 상태를 모르는 순수 타이머 — "언제 예약/취소하나"의 정책은 호출자(index.ts)가 가진다.
 */
export class RecordingGrace {
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly graceMs: number,
    private readonly onExpire: () => void
  ) {}

  /** 이미 예약돼 있으면 무시한다(중복 예약 방지). */
  schedule() {
    if (this.timer) {
      return;
    }
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.onExpire();
    }, this.graceMs);
    (this.timer as { unref?: () => void }).unref?.();
  }

  cancel() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }

  isPending(): boolean {
    return Boolean(this.timer);
  }
}
