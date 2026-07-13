/**
 * MJPEG 파이프 스트림을 JPEG 마커 구조로 워킹해 완성 프레임 단위로 잘라내는 순수 파서.
 *
 * 왜 바이트 스캔이 아니라 마커 워킹인가: MJPEG 프레임의 DQT/DHT/APPn 세그먼트
 * 페이로드(양자화·허프만 테이블 바이트)에 0xFFD8/0xFFD9와 같은 바이트열이 박힐 수
 * 있어, 단순히 FFD8~FFD9를 스캔하면 프레임을 중간에서 오분할해 간헐 손상을 낸다.
 * 길이필드 세그먼트는 페이로드를 마커로 스캔하지 않고 통째로 건너뛰어(correct-by-
 * construction) 오인 가능성을 원천 차단한다.
 *
 * ffmpeg → 파서 계약은 "바이트 청크 push → 완성 프레임 배열"이며, 앵커 소스(순번/PTS)
 * 교체와 무관하게 고정이다.
 */

// 파싱을 완료하기엔 바이트가 부족함을 뜻하는 센티널 (다음 push까지 보류).
const NEED_MORE = Symbol("need-more");

const MARKER_PREFIX = 0xff;
const SOI = 0xd8;
const EOI = 0xd9;
const SOS = 0xda;
const TEM = 0x01;
const RST_FIRST = 0xd0;
const RST_LAST = 0xd7;
const STUFF = 0x00;

const EMPTY = Buffer.alloc(0);

export class JpegStreamParser {
  // 아직 완성 프레임으로 방출되지 않은 잔여 바이트. 항상 SOI 후보 위치에 정렬된다.
  private buffer: Buffer = EMPTY;

  /** 바이트 청크를 공급하고, 이번 push로 완성된 프레임들을 순서대로 반환한다. */
  push(chunk: Buffer): Buffer[] {
    this.buffer = this.buffer.length > 0 ? Buffer.concat([this.buffer, chunk]) : chunk;
    const frames: Buffer[] = [];
    for (;;) {
      const frame = this.parseOne();
      if (frame === NEED_MORE) {
        break;
      }
      frames.push(frame);
    }
    return frames;
  }

  /** 새 캡처 프로세스 경계에서 이전 프로세스의 미완성 잔여를 버린다. */
  reset(): void {
    this.buffer = EMPTY;
  }

  /** 버퍼 앞에서 완성 프레임 한 장을 잘라내거나, 부족하면 NEED_MORE. */
  private parseOne(): Buffer | typeof NEED_MORE {
    const soi = this.findSoi(this.buffer);
    if (soi < 0) {
      // SOI 미발견 — 청크 경계에 걸린 FF일 수 있으니 마지막 FF 한 바이트만 보존.
      const tail = this.buffer;
      this.buffer = tail.length > 0 && tail[tail.length - 1] === MARKER_PREFIX ? tail.subarray(tail.length - 1) : EMPTY;
      return NEED_MORE;
    }
    if (soi > 0) {
      // SOI 앞 쓰레기 바이트 버림.
      this.buffer = this.buffer.subarray(soi);
    }
    const end = this.findFrameEnd(this.buffer, 2);
    if (end === NEED_MORE) {
      return NEED_MORE;
    }
    const frame = this.buffer.subarray(0, end);
    this.buffer = this.buffer.subarray(end);
    return frame;
  }

  /** SOI(FFD8) 시작 인덱스. 미발견 시 -1. */
  private findSoi(buf: Buffer): number {
    for (let i = 0; i + 1 < buf.length; i += 1) {
      if (buf[i] === MARKER_PREFIX && buf[i + 1] === SOI) {
        return i;
      }
    }
    return -1;
  }

  /** SOI 직후(pos)부터 마커를 워킹해 EOI 다음 인덱스를 반환하거나 NEED_MORE. */
  private findFrameEnd(buf: Buffer, start: number): number | typeof NEED_MORE {
    let pos = start;
    for (;;) {
      if (pos >= buf.length) {
        return NEED_MORE;
      }
      // 마커는 FF로 시작. 비-FF는 구조상 나오면 안 되지만, 무한루프 방지 위해 스킵.
      if (buf[pos] !== MARKER_PREFIX) {
        pos += 1;
        continue;
      }
      // 마커 사이 FF 패딩을 모두 건너뛰고 마커 코드 바이트를 찾는다.
      let code = pos + 1;
      while (code < buf.length && buf[code] === MARKER_PREFIX) {
        code += 1;
      }
      if (code >= buf.length) {
        return NEED_MORE;
      }
      const marker = buf[code];
      if (marker === EOI) {
        return code + 1;
      }
      if (marker === SOI || marker === TEM || (marker >= RST_FIRST && marker <= RST_LAST)) {
        // standalone 마커 — 길이필드 없음.
        pos = code + 1;
        continue;
      }
      if (marker === SOS) {
        const headerEnd = this.skipLengthSegment(buf, code);
        if (headerEnd === NEED_MORE) {
          return NEED_MORE;
        }
        const entropyEnd = this.scanEntropy(buf, headerEnd);
        if (entropyEnd === NEED_MORE) {
          return NEED_MORE;
        }
        // 엔트로피 종료 = 다음 마커의 FF 위치. progressive면 다음 SOS로 루프백.
        pos = entropyEnd;
        continue;
      }
      // 길이필드 세그먼트(DQT/DHT/APPn/DRI/COM/SOFn 등) — 통째 스킵.
      const segEnd = this.skipLengthSegment(buf, code);
      if (segEnd === NEED_MORE) {
        return NEED_MORE;
      }
      pos = segEnd;
    }
  }

  /**
   * 마커 코드 인덱스(code)의 세그먼트를 길이필드로 건너뛴다.
   * 길이는 code+1..code+2의 big-endian 2바이트로, 자기 자신(2바이트)을 포함한다.
   */
  private skipLengthSegment(buf: Buffer, code: number): number | typeof NEED_MORE {
    if (code + 2 >= buf.length) {
      return NEED_MORE;
    }
    const length = (buf[code + 1] << 8) | buf[code + 2];
    const next = code + 1 + length;
    if (next > buf.length) {
      return NEED_MORE;
    }
    return next;
  }

  /** SOS 헤더 이후 엔트로피 구간을 소비하고, 다음 실제 마커의 FF 위치를 반환한다. */
  private scanEntropy(buf: Buffer, start: number): number | typeof NEED_MORE {
    let pos = start;
    while (pos < buf.length) {
      if (buf[pos] !== MARKER_PREFIX) {
        pos += 1;
        continue;
      }
      if (pos + 1 >= buf.length) {
        return NEED_MORE;
      }
      const next = buf[pos + 1];
      if (next === STUFF || (next >= RST_FIRST && next <= RST_LAST)) {
        // FF00 스터핑·FFD0~D7 restart marker는 엔트로피 데이터로 소비.
        pos += 2;
        continue;
      }
      if (next === MARKER_PREFIX) {
        // 연속 FF 패딩 — 다음 바이트를 마커로 재평가.
        pos += 1;
        continue;
      }
      // 그 외 FFxx(EOI 또는 다음 SOS 등) — 엔트로피 종료, FF 위치 반환.
      return pos;
    }
    return NEED_MORE;
  }
}
