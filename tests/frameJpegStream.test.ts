import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { JpegStreamParser } from "../src/server/frameJpegStream";

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = path.join(here, "fixtures", "mjpeg-stream.bin");

const SOI = Buffer.from([0xff, 0xd8]);
const EOI = Buffer.from([0xff, 0xd9]);

/** 길이필드 세그먼트(FF <marker> <len hi> <len lo> <payload>) — length는 자기 2바이트 포함. */
function segment(marker: number, payload: Buffer): Buffer {
  const length = payload.length + 2;
  return Buffer.concat([Buffer.from([0xff, marker, (length >> 8) & 0xff, length & 0xff]), payload]);
}

/**
 * 검증용 합성 프레임. 테이블 세그먼트 페이로드에 FFD8/FFD9를 심고(오분할 유발 지점),
 * 엔트로피에 FF00 스터핑·FFD0 restart marker를 넣어 조기종료 유발 지점을 함께 담는다.
 */
function buildSyntheticFrame(tag: number): Buffer {
  const app0 = segment(0xe0, Buffer.from([0xff, 0xd9, 0x01, tag]));
  const dqt = segment(0xdb, Buffer.from([0x00, 0xff, 0xd8, 0xff, 0xd9, 0x11, tag]));
  const dht = segment(0xc4, Buffer.from([0xff, 0xd8, 0x00, 0xff, 0xd9]));
  const sosHeader = segment(0xda, Buffer.from([0x01, 0x01, 0x00, 0x00, 0x3f, 0x00]));
  const entropy = Buffer.from([0x12, tag, 0xff, 0x00, 0x56, 0xff, 0xd0, 0x78, 0xff, 0x00]);
  return Buffer.concat([SOI, app0, dqt, dht, sosHeader, entropy, EOI]);
}

function assertJpegBoundaries(frame: Buffer): void {
  expect(frame.subarray(0, 2).equals(SOI)).toBe(true);
  expect(frame.subarray(frame.length - 2).equals(EOI)).toBe(true);
}

describe("JpegStreamParser", () => {
  it("does not mis-split on FFD8/FFD9 embedded in DQT/DHT/APP0 segment payloads (a)", () => {
    const frame = buildSyntheticFrame(0xa1);
    const parser = new JpegStreamParser();

    const frames = parser.push(frame);

    expect(frames).toHaveLength(1);
    expect(frames[0].equals(frame)).toBe(true);
    assertJpegBoundaries(frames[0]);
  });

  it("does not terminate entropy early on FF00 stuffing or FFD0~D7 restart markers (b)", () => {
    // buildSyntheticFrame의 엔트로피에 FF00·FFD0가 들어있다 — 그걸 지나 EOI까지 한 장으로 소비해야 한다.
    const frame = buildSyntheticFrame(0xb2);
    const parser = new JpegStreamParser();

    const frames = parser.push(frame);

    expect(frames).toHaveLength(1);
    expect(frames[0].length).toBe(frame.length);
    expect(frames[0].equals(frame)).toBe(true);
  });

  it("reassembles a single frame delivered across many pushes (c)", () => {
    const frame = buildSyntheticFrame(0xc3);
    const parser = new JpegStreamParser();

    const collected: Buffer[] = [];
    for (const byte of frame) {
      collected.push(...parser.push(Buffer.from([byte])));
    }

    expect(collected).toHaveLength(1);
    expect(collected[0].equals(frame)).toBe(true);
  });

  it("splits multiple frames arriving in a single push (d)", () => {
    const first = buildSyntheticFrame(0xd4);
    const second = buildSyntheticFrame(0xd5);
    const parser = new JpegStreamParser();

    const frames = parser.push(Buffer.concat([first, second]));

    expect(frames).toHaveLength(2);
    expect(frames[0].equals(first)).toBe(true);
    expect(frames[1].equals(second)).toBe(true);
  });

  it("holds a trailing EOI-less partial without emitting or losing it (e)", () => {
    const frame = buildSyntheticFrame(0xe6);
    const partial = frame.subarray(0, frame.length - 2); // EOI 제거
    const parser = new JpegStreamParser();

    expect(parser.push(partial)).toHaveLength(0);

    // 뒤이어 EOI가 오면 보관하던 partial과 합쳐 완성 프레임으로 방출.
    const frames = parser.push(EOI);
    expect(frames).toHaveLength(1);
    expect(frames[0].equals(frame)).toBe(true);
  });

  it("drops a partial from a previous process on reset() (spawn boundary)", () => {
    const frame = buildSyntheticFrame(0xf7);
    const parser = new JpegStreamParser();
    parser.push(frame.subarray(0, frame.length - 2));

    parser.reset();

    // reset 후 온전한 새 프레임만 방출되고, 버려진 partial과 뒤섞이지 않는다.
    const fresh = buildSyntheticFrame(0xf8);
    const frames = parser.push(fresh);
    expect(frames).toHaveLength(1);
    expect(frames[0].equals(fresh)).toBe(true);
  });

  describe("real ffmpeg mjpeg fixture", () => {
    const fixture = readFileSync(FIXTURE_PATH);

    it("parses every frame from a whole-buffer push with no leftover bytes", () => {
      const parser = new JpegStreamParser();
      const frames = parser.push(fixture);

      expect(frames.length).toBe(4);
      for (const frame of frames) {
        assertJpegBoundaries(frame);
      }
      // image2pipe 출력은 프레임 연속 — 방출본을 이으면 원본과 정확히 일치(무결성).
      expect(Buffer.concat(frames).equals(fixture)).toBe(true);
    });

    it("parses the same frames when the fixture is chunked at arbitrary boundaries", () => {
      const parser = new JpegStreamParser();
      const collected: Buffer[] = [];
      const CHUNK = 1000;
      for (let offset = 0; offset < fixture.length; offset += CHUNK) {
        collected.push(...parser.push(fixture.subarray(offset, offset + CHUNK)));
      }

      expect(collected.length).toBe(4);
      expect(Buffer.concat(collected).equals(fixture)).toBe(true);
    });
  });
});
