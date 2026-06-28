import { describe, it, expect, vi, beforeEach } from "vitest";

const readDetectorCounts = vi.fn();
const readLatestFinding = vi.fn();
const detectorFindMany = vi.fn();
const projectFindUnique = vi.fn();
const sendDigestAlertSlack = vi.fn();
const sendDigestAlertEmail = vi.fn();

vi.mock("../../detection/findings-reader.js", () => ({
  readDetectorCounts: (...a: any[]) => readDetectorCounts(...a),
  readLatestFinding: (...a: any[]) => readLatestFinding(...a),
}));

vi.mock("@traceroot/core", () => ({
  prisma: {
    detector: { findMany: (...a: any[]) => detectorFindMany(...a) },
    project: { findUnique: (...a: any[]) => projectFindUnique(...a) },
  },
}));

vi.mock("../../notifications/slack.js", () => ({
  sendDigestAlertSlack: (...a: any[]) => sendDigestAlertSlack(...a),
}));

vi.mock("../../notifications/email.js", () => ({
  sendDigestAlertEmail: (...a: any[]) => sendDigestAlertEmail(...a),
}));

// Avoid pulling bullmq's Redis connection in the factory's module init.
vi.mock("../../queues/digest-queue.js", () => ({
  DETECTOR_DIGEST_QUEUE: "detector-digest",
  createRedisConnection: vi.fn(),
}));

const PROJECT = {
  name: "Acme Corp",
  alertConfig: { emailAddresses: ["a@example.com"], slackChannelId: "C123" },
  workspace: { id: "ws1", slackIntegration: { channelId: "C999", botToken: "enc-token" } },
};

beforeEach(() => {
  vi.clearAllMocks();
  readDetectorCounts.mockResolvedValue({
    d1: { finding_count: 4, run_count: 9 },
    d2: { finding_count: 1, run_count: 3 },
  });
  readLatestFinding.mockImplementation(async (_p: string, id: string) => `trace-${id}`);
  detectorFindMany.mockResolvedValue([
    { id: "d1", name: "Latency", enableRca: true },
    { id: "d2", name: "Errors", enableRca: true },
  ]);
  projectFindUnique.mockResolvedValue(PROJECT);
  sendDigestAlertSlack.mockResolvedValue(undefined);
  sendDigestAlertEmail.mockResolvedValue(undefined);
});

async function run() {
  const { flushDigest } = await import("../detector-digest-processor.js");
  await flushDigest({ projectId: "p1", windowStart: 0, windowMs: 1_800_000 });
}

describe("flushDigest", () => {
  it("builds one digest grouped by detector and sends it on both channels", async () => {
    await run();

    expect(sendDigestAlertSlack).toHaveBeenCalledTimes(1);
    expect(sendDigestAlertEmail).toHaveBeenCalledTimes(1);

    const slackArg = sendDigestAlertSlack.mock.calls[0][0];
    expect(slackArg.entries).toHaveLength(2);
    expect(slackArg.total).toBe(5);
    expect(slackArg.channelId).toBe("C123"); // alertConfig wins over integration default
    expect(slackArg.encryptedBotToken).toBe("enc-token");
    expect(slackArg.entries).toContainEqual({
      detectorId: "d1",
      detectorName: "Latency",
      findingCount: 4,
      latestTraceId: "trace-d1",
    });

    const emailArg = sendDigestAlertEmail.mock.calls[0][0];
    expect(emailArg.to).toEqual(["a@example.com"]);
    expect(emailArg.entries).toHaveLength(2);
    expect(emailArg.total).toBe(5);
  });

  it("drops detectors with enableRca === false from the digest", async () => {
    detectorFindMany.mockResolvedValue([
      { id: "d1", name: "Latency", enableRca: true },
      { id: "d2", name: "Errors", enableRca: false },
    ]);

    await run();

    const slackArg = sendDigestAlertSlack.mock.calls[0][0];
    expect(slackArg.entries).toHaveLength(1);
    expect(slackArg.entries[0].detectorId).toBe("d1");
    expect(slackArg.total).toBe(4);
  });

  it("sends nothing when no detector has findings in the window", async () => {
    readDetectorCounts.mockResolvedValue({
      d1: { finding_count: 0, run_count: 9 },
      d2: { finding_count: 0, run_count: 3 },
    });

    await run();

    expect(detectorFindMany).not.toHaveBeenCalled();
    expect(sendDigestAlertSlack).not.toHaveBeenCalled();
    expect(sendDigestAlertEmail).not.toHaveBeenCalled();
  });

  it("sends nothing when only RCA-disabled detectors fired", async () => {
    detectorFindMany.mockResolvedValue([
      { id: "d1", name: "Latency", enableRca: false },
      { id: "d2", name: "Errors", enableRca: false },
    ]);

    await run();

    // resolveRecipients runs first (project has channels), but we still bail at
    // the RCA-disabled filter before building entries or sending.
    expect(readLatestFinding).not.toHaveBeenCalled();
    expect(sendDigestAlertSlack).not.toHaveBeenCalled();
    expect(sendDigestAlertEmail).not.toHaveBeenCalled();
  });

  it("skips Slack when no channel is configured but still emails", async () => {
    projectFindUnique.mockResolvedValue({
      ...PROJECT,
      alertConfig: { emailAddresses: ["a@example.com"], slackChannelId: null },
      workspace: { id: "ws1", slackIntegration: null },
    });

    await run();

    expect(sendDigestAlertSlack).not.toHaveBeenCalled();
    expect(sendDigestAlertEmail).toHaveBeenCalledTimes(1);
  });

  it("returns without sending when the project is gone", async () => {
    projectFindUnique.mockResolvedValue(null);

    await run();

    expect(readDetectorCounts).not.toHaveBeenCalled(); // resolved first, bailed before the count read
    expect(sendDigestAlertSlack).not.toHaveBeenCalled();
    expect(sendDigestAlertEmail).not.toHaveBeenCalled();
  });

  it("short-circuits before reading counts when the project has no channels", async () => {
    projectFindUnique.mockResolvedValue({
      name: "Acme Corp",
      alertConfig: { emailAddresses: [], slackChannelId: null },
      workspace: { id: "ws1", slackIntegration: null },
    });

    await run();

    expect(readDetectorCounts).not.toHaveBeenCalled();
    expect(detectorFindMany).not.toHaveBeenCalled();
    expect(sendDigestAlertSlack).not.toHaveBeenCalled();
    expect(sendDigestAlertEmail).not.toHaveBeenCalled();
  });
});
