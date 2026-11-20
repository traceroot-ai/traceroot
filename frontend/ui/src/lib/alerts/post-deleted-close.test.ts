import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { resolveAlertChannel, createSlackClient, postMessage, buildAlertClosedBlocks, decryptKey } =
  vi.hoisted(() => {
    const postMessage = vi.fn();
    return {
      resolveAlertChannel: vi.fn(),
      postMessage,
      createSlackClient: vi.fn((_token: string, _bound?: unknown) => ({ chat: { postMessage } })),
      buildAlertClosedBlocks: vi.fn((_params: unknown) => ({
        blocks: [{ type: "header" }],
        color: "#1a7f4e",
        text: "[OK] P95 latency",
      })),
      decryptKey: vi.fn((cipher: string) => `decrypted(${cipher})`),
    };
  });

vi.mock("@traceroot/slack", () => ({
  resolveAlertChannel,
  createSlackClient,
  buildAlertClosedBlocks,
}));
vi.mock("@traceroot/core", () => ({ decryptKey }));

import { postDeletedAlertClose } from "./post-deleted-close";

const close = { projectId: "p1", alertId: "alert-1", name: "P95 latency", actorName: "Ada" };

beforeEach(() => {
  resolveAlertChannel.mockReset().mockResolvedValue({
    ok: true,
    target: { channelId: "C_ALERTS", encryptedBotToken: "enc-token" },
  });
  postMessage.mockReset().mockResolvedValue({ ok: true });
  createSlackClient.mockClear();
  buildAlertClosedBlocks.mockClear();
  decryptKey.mockClear();
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("postDeletedAlertClose", () => {
  it("posts the deleted close to the rule's channel with one short try", async () => {
    await postDeletedAlertClose(close);

    expect(resolveAlertChannel).toHaveBeenCalledWith("p1");
    expect(buildAlertClosedBlocks).toHaveBeenCalledWith({
      appBaseUrl: expect.any(String),
      projectId: "p1",
      alertId: "alert-1",
      name: "P95 latency",
      reason: "deleted",
      actor: "Ada",
    });
    // The delete is waiting on this: no retries, and a bound well under a request timeout.
    expect(createSlackClient).toHaveBeenCalledWith("decrypted(enc-token)", {
      timeoutMs: 3_000,
      retries: 0,
    });
    expect(postMessage).toHaveBeenCalledWith({
      channel: "C_ALERTS",
      attachments: [{ color: "#1a7f4e", blocks: [{ type: "header" }] }],
      text: "[OK] P95 latency",
      unfurl_links: false,
      unfurl_media: false,
    });
  });

  it("logs and sends nothing when the channel cannot be resolved", async () => {
    resolveAlertChannel.mockResolvedValue({ ok: false, reason: "no-channel" });

    await expect(postDeletedAlertClose(close)).resolves.toBeUndefined();

    expect(postMessage).not.toHaveBeenCalled();
    expect(console.info).toHaveBeenCalledWith(expect.stringContaining("reason=no-channel"));
  });

  it.each([
    [
      "the token will not decrypt",
      () =>
        decryptKey.mockImplementationOnce(() => {
          throw new Error("bad key");
        }),
    ],
    ["Slack refuses the post", () => postMessage.mockRejectedValue(new Error("channel_not_found"))],
    ["Slack times out", () => postMessage.mockRejectedValue(new Error("timeout of 3000ms"))],
    [
      "the channel lookup itself fails",
      () => resolveAlertChannel.mockRejectedValue(new Error("db")),
    ],
  ])("never throws when %s, and logs it", async (_case, arrange) => {
    arrange();

    await expect(postDeletedAlertClose(close)).resolves.toBeUndefined();

    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining("deleted close not sent alert=alert-1 project=p1"),
      expect.any(Error),
    );
  });
});
