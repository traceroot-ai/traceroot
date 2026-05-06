import { beforeEach, describe, expect, it, vi } from "vitest";

const postMessage = vi.fn();
const createSlackClient = vi.fn((_token: string) => ({ chat: { postMessage } }));

vi.mock("@traceroot/slack", () => ({
  createSlackClient: (token: string) => createSlackClient(token),
  buildCombinedAlertBlocks: () => [{ type: "section", text: { type: "mrkdwn", text: "block" } }],
}));
vi.mock("@traceroot/core", () => ({
  decryptKey: (s: string) => `decrypted(${s})`,
}));

describe("sendCombinedAlertSlack", () => {
  beforeEach(() => {
    postMessage.mockReset();
    createSlackClient.mockClear();
  });

  it("decrypts the token, builds blocks, and posts to the channel", async () => {
    postMessage.mockResolvedValue({ ok: true, ts: "1234.5678" });
    const { sendCombinedAlertSlack } = await import("../notifications/slack.js");
    await sendCombinedAlertSlack({
      encryptedBotToken: "enc-tok",
      channelId: "C1",
      detectorName: "Hallucination",
      projectName: "billing",
      summary: "x",
      traceId: "abcd",
      projectId: "p1",
      rcaResult: null,
    });
    expect(createSlackClient).toHaveBeenCalledWith("decrypted(enc-tok)");
    expect(postMessage).toHaveBeenCalledTimes(1);
    const arg = postMessage.mock.calls[0][0];
    expect(arg.channel).toBe("C1");
    expect(arg.unfurl_links).toBe(false);
    expect(Array.isArray(arg.blocks)).toBe(true);
  });

  it("throws on a Slack API failure", async () => {
    const err: any = new Error("not_in_channel");
    err.data = { error: "not_in_channel" };
    postMessage.mockRejectedValue(err);
    const { sendCombinedAlertSlack } = await import("../notifications/slack.js");
    await expect(
      sendCombinedAlertSlack({
        encryptedBotToken: "enc-tok",
        channelId: "C1",
        detectorName: "x",
        projectName: "x",
        summary: "x",
        traceId: "x",
        projectId: "x",
        rcaResult: null,
      }),
    ).rejects.toThrow(/not_in_channel/);
  });
});
