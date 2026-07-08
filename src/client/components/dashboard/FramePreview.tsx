import { useState } from "react";
import type { ChatProvider } from "../../../shared/types";

/**
 * 해당 시각의 방송 프레임. provider에 캡처가 없으면(404) fallbackProvider로 한 번 더 시도하고,
 * 그마저 없으면 조용히 숨긴다. provider/second가 바뀌면 부모가 key로 이 컴포넌트를 새로 마운트해서
 * 재시도 상태를 리셋시킨다.
 */
export function FramePreview({
  second,
  provider,
  fallbackProvider,
  large
}: {
  second: number;
  provider: ChatProvider;
  fallbackProvider?: ChatProvider;
  large?: boolean;
}) {
  const [attempt, setAttempt] = useState<"primary" | "fallback" | "failed">("primary");
  if (attempt === "failed") {
    return null;
  }
  const activeProvider = attempt === "fallback" && fallbackProvider ? fallbackProvider : provider;
  return (
    <img
      alt=""
      className={large ? "frame-preview frame-preview-large" : "frame-preview"}
      loading="lazy"
      onError={() => setAttempt((current) => (current === "primary" && fallbackProvider ? "fallback" : "failed"))}
      src={`/api/frames/${activeProvider}/${second}.jpg`}
    />
  );
}
