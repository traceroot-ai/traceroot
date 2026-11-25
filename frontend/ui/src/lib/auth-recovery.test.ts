import { describe, expect, it } from "vitest";
import { unprovenIdentities } from "./auth-recovery";

const acc = (providerId: string) => ({ id: `id-${providerId}`, providerId });

describe("unprovenIdentities", () => {
  it.each([
    ["unverified, AgentID only", false, ["agentid"], ["agentid"]],
    ["unverified, password and Google", false, ["credential", "google"], ["google"]],
    ["unverified, GitHub", false, ["github"], ["github"]],
    ["verified, Google and AgentID", true, ["credential", "google", "agentid"], ["agentid"]],
    ["verified, Google and GitHub", true, ["google", "github"], []],
    ["verified, password only", true, ["credential"], []],
    ["unverified, password only", false, ["credential"], []],
  ])("%s", (_case, emailVerified, providers, dropped) => {
    expect(
      unprovenIdentities({ emailVerified }, providers.map(acc)).map((a) => a.providerId),
    ).toEqual(dropped);
  });
});
