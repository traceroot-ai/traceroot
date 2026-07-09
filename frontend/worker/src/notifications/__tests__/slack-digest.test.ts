import { beforeEach, describe, expect, it, vi } from "vitest";

const postMessage = vi.fn();
const createSlackClient = vi.fn((_token: string) => ({ chat: { postMessage } }));
const buildDigestAlertBlocks = vi.fn(() => [
  { type: "section", text: { type: "mrkdwn", text: "digest" } },
]);
const findUnique = vi.fn();
const hasEntitlement = vi.fn();

vi.mock("@traceroot/slack", () => ({
  createSlackClient: (token: string) => createSlackClient(token),
  buildDigestAlertBlocks: (...a: unknown[]) => buildDigestAlertBlocks(...(a as [])),
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
  projectId: "p1",
  projectName: "billing",
  windowStart: new Date(0),
  windowEnd: new Date(1000),
  total: 2,
  entries: [],
};

describe("sendDigestAlertSlack", () => {
  beforeEach(() => {
    postMessage.mockReset();
    createSlackClient.mockClear();
    buildDigestAlertBlocks.mockClear();
    findUnique.mockReset();
    hasEntitlement.mockReset();
  });

  it("posts digest blocks when the workspace has the slack entitlement", async () => {
    findUnique.mockResolvedValue({ billingPlan: "starter" });
    hasEntitlement.mockReturnValue(true);
    postMessage.mockResolvedValue({ ok: true, ts: "1.2" });

    const { sendDigestAlertSlack } = await import("../slack.js");
    await sendDigestAlertSlack(baseParams);

    expect(hasEntitlement).toHaveBeenCalledWith("starter", "slack-integration");
    expect(createSlackClient).toHaveBeenCalledWith("decrypted(enc-tok)");
    expect(buildDigestAlertBlocks).toHaveBeenCalledTimes(1);
    expect(postMessage).toHaveBeenCalledTimes(1);
    const arg = postMessage.mock.calls[0][0];
    expect(arg.channel).toBe("C1");
    expect(arg.text).toContain("2 findings");
    expect(arg.unfurl_links).toBe(false);
    expect(Array.isArray(arg.blocks)).toBe(true);
  });

  it("treats a missing workspace row as free plan", async () => {
    findUnique.mockResolvedValue(null);
    hasEntitlement.mockReturnValue(true);
    postMessage.mockResolvedValue({ ok: true });

    const { sendDigestAlertSlack } = await import("../slack.js");
    await sendDigestAlertSlack(baseParams);

    expect(hasEntitlement).toHaveBeenCalledWith("free", "slack-integration");
    expect(postMessage).toHaveBeenCalledTimes(1);
  });

  it("silently skips when the entitlement check returns false", async () => {
    findUnique.mockResolvedValue({ billingPlan: "free" });
    hasEntitlement.mockReturnValue(false);

    const { sendDigestAlertSlack } = await import("../slack.js");
    await sendDigestAlertSlack(baseParams);

    expect(createSlackClient).not.toHaveBeenCalled();
    expect(postMessage).not.toHaveBeenCalled();
  });
});
