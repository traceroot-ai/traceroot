import { beforeEach, describe, expect, it, vi } from "vitest";

const postMessage = vi.fn();
const createSlackClient = vi.fn((_token: string) => ({ chat: { postMessage } }));
const findUnique = vi.fn();
const hasEntitlement = vi.fn();

vi.mock("@traceroot/slack", () => ({
  createSlackClient: (token: string) => createSlackClient(token),
  buildCombinedAlertBlocks: () => [{ type: "section", text: { type: "mrkdwn", text: "block" } }],
}));
vi.mock("@traceroot/core", () => ({
  decryptKey: (s: string) => `decrypted(${s})`,
  hasEntitlement: (...a: unknown[]) => hasEntitlement(...a),
  prisma: { workspace: { findUnique: (...a: unknown[]) => findUnique(...a) } },
}));

const baseParams = {
  workspaceId: "ws_1",
  encryptedBotToken: "enc-tok",
  channelId: "C1",
  detectorName: "Hallucination",
  projectName: "billing",
  summary: "x",
  traceId: "abcd",
  projectId: "p1",
  rcaResult: null,
};

describe("sendCombinedAlertSlack", () => {
  beforeEach(() => {
    postMessage.mockReset();
    createSlackClient.mockClear();
    findUnique.mockReset();
    hasEntitlement.mockReset();
  });

  it("posts to the channel when workspace plan has slack-integration entitlement", async () => {
    findUnique.mockResolvedValue({ billingPlan: "starter" });
    hasEntitlement.mockReturnValue(true);
    postMessage.mockResolvedValue({ ok: true, ts: "1234.5678" });

    const { sendCombinedAlertSlack } = await import("../notifications/slack.js");
    await sendCombinedAlertSlack(baseParams);

    expect(hasEntitlement).toHaveBeenCalledWith("starter", "slack-integration");
    expect(createSlackClient).toHaveBeenCalledWith("decrypted(enc-tok)");
    expect(postMessage).toHaveBeenCalledTimes(1);
    const arg = postMessage.mock.calls[0][0];
    expect(arg.channel).toBe("C1");
    expect(arg.unfurl_links).toBe(false);
    expect(Array.isArray(arg.blocks)).toBe(true);
  });

  // Defense-in-depth: every current plan is entitled to slack-integration, so
  // this branch is unreachable in production today. The guard still protects
  // against a future entitlement-config change, so we verify it skips cleanly
  // whenever hasEntitlement returns false (plan value is irrelevant here).
  it("silently skips when the entitlement check returns false", async () => {
    findUnique.mockResolvedValue({ billingPlan: "free" });
    hasEntitlement.mockReturnValue(false);

    const { sendCombinedAlertSlack } = await import("../notifications/slack.js");
    await sendCombinedAlertSlack(baseParams);

    expect(createSlackClient).not.toHaveBeenCalled();
    expect(postMessage).not.toHaveBeenCalled();
  });

  it("treats a missing workspace row as free plan and sends", async () => {
    findUnique.mockResolvedValue(null);
    hasEntitlement.mockReturnValue(true);
    postMessage.mockResolvedValue({ ok: true, ts: "1234.5678" });

    const { sendCombinedAlertSlack } = await import("../notifications/slack.js");
    await sendCombinedAlertSlack(baseParams);

    expect(hasEntitlement).toHaveBeenCalledWith("free", "slack-integration");
    expect(createSlackClient).toHaveBeenCalledWith("decrypted(enc-tok)");
    expect(postMessage).toHaveBeenCalledTimes(1);
  });

  it("throws on a Slack API failure when entitled", async () => {
    findUnique.mockResolvedValue({ billingPlan: "pro" });
    hasEntitlement.mockReturnValue(true);
    const err: any = new Error("not_in_channel");
    err.data = { error: "not_in_channel" };
    postMessage.mockRejectedValue(err);

    const { sendCombinedAlertSlack } = await import("../notifications/slack.js");
    await expect(sendCombinedAlertSlack(baseParams)).rejects.toThrow(/not_in_channel/);
  });
});
