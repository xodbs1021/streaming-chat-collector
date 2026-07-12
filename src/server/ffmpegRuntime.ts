import { spawn } from "node:child_process";

/**
 * ffmpeg 실행 가능 여부를 부팅 시 1회 프로브해 캐시한다 (모듈 싱글턴, 두 캡처 매니저 공유).
 * 판정은 순수함수로 분리해 테스트 가능하게 두고, spawn/캐시는 얇게 감싼다.
 */
export type FfmpegProbeResult =
  | { kind: "spawn-error"; code?: string } // spawn 자체 실패 (ENOENT 등) → 미설치로 간주
  | { kind: "exit"; code: number | null }; // 프로세스 종료 코드

export type FfmpegReadiness = "unknown" | "ready" | "missing";

/** 프로브 결과를 ready/missing으로 판정 — spawn 에러나 비정상 종료는 missing, exit 0만 ready */
export function classifyFfmpegProbe(result: FfmpegProbeResult): "ready" | "missing" {
  if (result.kind === "spawn-error") {
    return "missing";
  }
  return result.code === 0 ? "ready" : "missing";
}

let readiness: FfmpegReadiness = "unknown";
let probePromise: Promise<FfmpegReadiness> | undefined;

/** 부팅 워밍업 이후 캐시된 상태를 반환한다 (프로브 전이면 "unknown") */
export function getFfmpegReadiness(): FfmpegReadiness {
  return readiness;
}

/** `ffmpeg -version`을 1회 실행해 readiness를 캐시한다. 중복 호출은 첫 프로브를 공유한다. */
export function probeFfmpeg(): Promise<FfmpegReadiness> {
  if (!probePromise) {
    probePromise = runProbe().then((result) => {
      readiness = classifyFfmpegProbe(result);
      return readiness;
    });
  }
  return probePromise;
}

function runProbe(): Promise<FfmpegProbeResult> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: FfmpegProbeResult) => {
      if (settled) {
        return;
      }
      settled = true;
      resolve(result);
    };
    const child = spawn("ffmpeg", ["-version"], { stdio: "ignore" });
    child.once("error", (error: NodeJS.ErrnoException) => finish({ kind: "spawn-error", code: error.code }));
    child.once("exit", (code) => finish({ kind: "exit", code }));
  });
}
