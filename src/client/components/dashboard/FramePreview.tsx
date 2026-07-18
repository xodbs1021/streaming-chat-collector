import { useState } from "react";
import type { ChatProvider } from "../../../shared/types";
import { frameImageUrl } from "../../frameIndexClient";

/**
 * 해당 시각의 방송 프레임. provider에 캡처가 없으면(404) fallbackProvider로 한 번 더 시도하고,
 * 그마저 없으면 조용히 숨긴다.
 *
 * 프레임이 넘어갈 때(second/provider 변경) 부모가 key로 remount하면 <img>가 새로 생성돼
 * 로드 완료 전까지 빈 화면이 노출돼 깜빡인다(flash). 그래서 부모는 이 컴포넌트를 remount하지 않고,
 * 여기서 프레임이 바뀌면 재시도 상태만 리셋한다 → 같은 <img>가 유지돼 브라우저가 이전 프레임을
 * 다음 프레임 로드될 때까지 그대로 보여주므로 깜빡임이 없다. (render 중 파생 리셋: 별도 effect·리렌더 없음)
 */
export function FramePreview({
  second,
  provider,
  fallbackProvider,
  broadcastId,
  large
}: {
  second: number;
  provider: ChatProvider;
  fallbackProvider?: ChatProvider;
  /** 있으면 과거 방송 주소로 읽는다 — 없으면 라이브 주소(현행). */
  broadcastId?: string;
  large?: boolean;
}) {
  // broadcastId를 키에 포함해 라이브 ↔ 과거 소스 전환 시 재시도 상태가 이월되지 않게 한다.
  const frameKey = `${provider}-${second}-${broadcastId ?? "live"}`;
  const [state, setState] = useState<{ frameKey: string; attempt: "primary" | "fallback" | "failed" }>({
    frameKey,
    attempt: "primary"
  });
  // 프레임이 바뀌면 이전 프레임의 실패/폴백 상태를 버리고 primary부터 다시 시도한다(remount 없이).
  const attempt = state.frameKey === frameKey ? state.attempt : "primary";

  if (attempt === "failed") {
    return null;
  }
  const activeProvider = attempt === "fallback" && fallbackProvider ? fallbackProvider : provider;
  return (
    <img
      alt=""
      className={large ? "frame-preview frame-preview-large" : "frame-preview"}
      onError={() =>
        setState({ frameKey, attempt: attempt === "primary" && fallbackProvider ? "fallback" : "failed" })
      }
      src={frameImageUrl(activeProvider, second, broadcastId)}
    />
  );
}
