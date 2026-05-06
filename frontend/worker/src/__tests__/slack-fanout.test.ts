import { beforeEach, describe, expect, it, vi } from "vitest";

const sendCombinedAlertEmail = vi.fn();
const sendCombinedAlertSlack = vi.fn();

vi.mock("../notifications/email.js", () => ({
  sendCombinedAlertEmail: (...a: unknown[]) => sendCombinedAlertEmail(...a),
}));
vi.mock("../notifications/slack.js", () => ({
  sendCombinedAlertSlack: (...a: unknown[]) => sendCombinedAlertSlack(...a),
}));

const baseCommon = {
  detectorName: "x",
  projectName: "p",
  summary: "s",
  rcaResult: null,
  traceId: "t",
  projectId: "pid",
};

describe("runFanOut", () => {
  beforeEach(() => {
    sendCombinedAlertEmail.mockReset().mockResolvedValue(undefined);
    sendCombinedAlertSlack.mockReset().mockResolvedValue(undefined);
  });

  it("sends email only when slack is not configured", async () => {
    const { runFanOut } = await import("../processors/detector-rca-processor.js");
    await runFanOut({
      emailAddresses: ["a@b.c"],
      slackChannelId: null,
      slackBotTokenEnc: null,
      common: baseCommon,
    });
    expect(sendCombinedAlertEmail).toHaveBeenCalledTimes(1);
    expect(sendCombinedAlertSlack).not.toHaveBeenCalled();
  });

  it("sends slack only when email is not configured", async () => {
    const { runFanOut } = await import("../processors/detector-rca-processor.js");
    await runFanOut({
      emailAddresses: [],
      slackChannelId: "C1",
      slackBotTokenEnc: "enc",
      common: baseCommon,
    });
    expect(sendCombinedAlertEmail).not.toHaveBeenCalled();
    expect(sendCombinedAlertSlack).toHaveBeenCalledTimes(1);
  });

  it("sends to both when both are configured", async () => {
    const { runFanOut } = await import("../processors/detector-rca-processor.js");
    await runFanOut({
      emailAddresses: ["a@b.c"],
      slackChannelId: "C1",
      slackBotTokenEnc: "enc",
      common: baseCommon,
    });
    expect(sendCombinedAlertEmail).toHaveBeenCalledTimes(1);
    expect(sendCombinedAlertSlack).toHaveBeenCalledTimes(1);
  });

  it("does nothing when neither configured", async () => {
    const { runFanOut } = await import("../processors/detector-rca-processor.js");
    await runFanOut({
      emailAddresses: [],
      slackChannelId: null,
      slackBotTokenEnc: null,
      common: baseCommon,
    });
    expect(sendCombinedAlertEmail).not.toHaveBeenCalled();
    expect(sendCombinedAlertSlack).not.toHaveBeenCalled();
  });
});
