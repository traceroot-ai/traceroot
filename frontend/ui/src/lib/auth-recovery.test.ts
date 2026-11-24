import { describe, expect, it } from "vitest";
import { identitiesToDropOnReset } from "./auth-recovery";

const acc = (providerId: string) => ({ id: `id-${providerId}`, providerId });

describe("identitiesToDropOnReset", () => {
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
      identitiesToDropOnReset({ emailVerified }, providers.map(acc)).map((a) => a.providerId),
    ).toEqual(dropped);
  });
});
