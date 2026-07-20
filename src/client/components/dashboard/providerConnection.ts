import type { ProviderStatusMap } from "../../../shared/types";
import { PROVIDER_ORDER } from "../../frameProviderSelection";

/**
 * 연결(재연결 포함) 중인 provider 수 — 녹화 버튼 활성 판정용.
 * 서버 connectedProviderRefs(index.ts:288)와 동일 술어(connected || reconnecting)를 미러한다.
 * 두 술어가 갈리면 "버튼은 눌리는데 서버가 무시"하는 경계면 괴리가 생기므로 이 테스트가 드리프트를 고정한다.
 */
export function countConnectedProviders(statuses: ProviderStatusMap): number {
  return PROVIDER_ORDER.filter((provider) => {
    const state = statuses[provider]?.state;
    return state === "connected" || state === "reconnecting";
  }).length;
}
