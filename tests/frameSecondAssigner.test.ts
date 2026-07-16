import { describe, expect, it } from "vitest";
import { FrameSecondAssigner, SHORT_GAP_MAX_SEC } from "../src/server/frameSecondAssigner";

const FRAME = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);

describe("FrameSecondAssigner", () => {
  it("names sequential frames as base..base+N by stream ordinal", () => {
    const assigner = new FrameSecondAssigner();
    const base = 1_000;

    const seconds = [0, 1, 2, 3, 4].map((offset) => assigner.assign(base + offset, FRAME).second);

    expect(seconds).toEqual([base, base + 1, base + 2, base + 3, base + 4]);
  });

  it("places a burst (same nowSec) into distinct consecutive seconds, not overwriting", () => {
    const assigner = new FrameSecondAssigner();
    const base = 2_000;

    // HLS 버퍼링으로 4장이 같은 벽시계 초에 몰려 도착 — 각자 base..base+3에 제자리 배치.
    const seconds = [0, 1, 2, 3].map(() => assigner.assign(base, FRAME).second);

    expect(seconds).toEqual([base, base + 1, base + 2, base + 3]);
    expect(new Set(seconds).size).toBe(4);
  });

  it("fills a short reconnect gap (<= SHORT_GAP_MAX_SEC) with the previous frame", () => {
    const assigner = new FrameSecondAssigner();
    // 첫 spawn 마지막 프레임 = 초 100.
    expect(assigner.assign(100, FRAME).second).toBe(100);
    assigner.resetSpawn();

    // 재접속 첫 프레임이 초 102에 옴 → 101 한 칸만 비어 짧은 공백 → 복제로 메움.
    const result = assigner.assign(102, FRAME);

    expect(result.second).toBe(102);
    expect(result.fills).toEqual([101]);
    expect(2 - 1).toBeLessThanOrEqual(SHORT_GAP_MAX_SEC);
  });

  it("leaves a long reconnect gap (> SHORT_GAP_MAX_SEC) empty", () => {
    const assigner = new FrameSecondAssigner();
    expect(assigner.assign(100, FRAME).second).toBe(100);
    assigner.resetSpawn();

    // 재접속 첫 프레임이 초 110에 옴 → 101..109(9칸) 공백은 실제 콘텐츠 공백으로 보고 비운다.
    const result = assigner.assign(110, FRAME);

    expect(result.second).toBe(110);
    expect(result.fills).toEqual([]);
  });

  it("guards monotonicity when the clock does not advance across a reconnect", () => {
    const assigner = new FrameSecondAssigner();
    expect(assigner.assign(500, FRAME).second).toBe(500);
    assigner.resetSpawn();

    // 새 spawn의 nowSec이 직전 초 이하(무진행) — base는 lastFrameSec+1로 바닥이 깔려야 한다.
    const first = assigner.assign(499, FRAME);
    expect(first.second).toBe(501);
    // 갭이 음수가 아니어야 하고, 인접(gap 0)이므로 복제도 없어야 한다.
    expect(first.fills).toEqual([]);
    const second = assigner.assign(499, FRAME);
    expect(second.second).toBe(502);
  });

  it("방송 경계 reset()은 lastFrame까지 버려 새 방송이 이전 방송 프레임을 갭필로 복제하지 않는다", () => {
    const assigner = new FrameSecondAssigner();
    // 이전 방송 마지막 프레임 = 초 100.
    expect(assigner.assign(100, FRAME).second).toBe(100);

    // 방송 경계 리셋 — resetSpawn과 달리 갭필 소스(lastFrameSec/lastFrameBuffer)까지 비운다.
    assigner.reset();
    expect(assigner.getLastFrameBuffer()).toBeUndefined();

    // 새 방송 첫 프레임이 초 102에 와도(짧은 공백 범위지만 이전 방송 소속) 101을 복제 갭필하지 않는다.
    // 같은 시나리오에서 resetSpawn()이었다면 fills === [101]로 이전 방송 프레임이 새 폴더에 유입됐을 것.
    const result = assigner.assign(102, FRAME);
    expect(result.second).toBe(102);
    expect(result.fills).toEqual([]);
  });

  it("exposes the previous frame buffer as the gap-fill source before assign updates it", () => {
    const assigner = new FrameSecondAssigner();
    const older = Buffer.from([0x01]);
    const newer = Buffer.from([0x02]);

    assigner.assign(700, older);
    expect(assigner.getLastFrameBuffer()?.equals(older)).toBe(true);

    assigner.assign(701, newer);
    expect(assigner.getLastFrameBuffer()?.equals(newer)).toBe(true);
  });

  it("holds the invariant: N contiguous seconds => N frames, a 5-second window => 5K frames", () => {
    const assigner = new FrameSecondAssigner();
    const base = 3_000;
    const total = 15; // 3개의 5초 윈도우

    const seconds = Array.from({ length: total }, (_unused, index) => assigner.assign(base + index, FRAME).second);

    // N초 구간 == N장(중복·구멍 없음).
    expect(new Set(seconds).size).toBe(total);
    expect(Math.max(...seconds) - Math.min(...seconds) + 1).toBe(total);

    // 임의의 5초 윈도우 K개 == 5K장.
    for (let windowStart = base; windowStart + 5 <= base + total; windowStart += 5) {
      const inWindow = seconds.filter((second) => second >= windowStart && second < windowStart + 5);
      expect(inWindow.length).toBe(5);
    }
  });
});
