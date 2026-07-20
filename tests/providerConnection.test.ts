import { describe, expect, it } from "vitest";
import { countConnectedProviders } from "../src/client/components/dashboard/providerConnection";
import type { ProviderState, ProviderStatus, ProviderStatusMap } from "../src/shared/types";

function status(state: ProviderState): ProviderStatus {
  return { provider: "chzzk", sourceMode: "unofficial", state, message: "" };
}

describe("countConnectedProviders", () => {
  it("counts providers that are connected", () => {
    const statuses: ProviderStatusMap = { chzzk: status("connected"), soop: status("connected") };
    expect(countConnectedProviders(statuses)).toBe(2);
  });

  it("counts a reconnecting provider as connected (mirrors server connectedProviderRefs predicate)", () => {
    const statuses: ProviderStatusMap = { chzzk: status("connected"), soop: status("reconnecting") };
    expect(countConnectedProviders(statuses)).toBe(2);
  });

  it("ignores providers that are neither connected nor reconnecting", () => {
    const statuses: ProviderStatusMap = { chzzk: status("offline"), soop: status("connecting") };
    expect(countConnectedProviders(statuses)).toBe(0);
  });

  it("returns 0 for an empty status map", () => {
    expect(countConnectedProviders({})).toBe(0);
  });
});
