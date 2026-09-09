import { describe, it, expect, vi, beforeEach } from "vitest";

const readDetectorWindowSummary = vi.fn();
const detectorFindMany = vi.fn();
const projectFindUnique = vi.fn();
const sendDigestAlertSlack = vi.fn();
const sendDigestAlertEmail = vi.fn();
const generateDigestSummary = vi.fn();
const aiMessageCreate = vi.fn();

vi.mock("../../detection/findings-reader.js", () => ({
  readDetectorWindowSummary: (...a: any[]) => readDetectorWindowSummary(...a),
}));

vi.mock("@traceroot/core", () => ({
  prisma: {
    detector: { findMany: (...a: any[]) => detectorFindMany(...a) },
    project: { findUnique: (...a: any[]) => projectFindUnique(...a) },
    aIMessage: { create: (...a: any[]) => aiMessageCreate(...a) },
  },
  PlanType: { FREE: "free" },
}));

vi.mock("../../notifications/digest-summary.js", () => ({
  generateDigestSummary: (...a: any[]) => generateDigestSummary(...a),
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
  rcaModel: null,
  rcaProvider: null,
  rcaSource: null,
  alertConfig: { emailAddresses: ["a@example.com"], slackChannelId: "C123" },
  workspace: {
    id: "ws1",
    billingPlan: "pro",
    rcaBlocked: false,
    slackIntegration: { channelId: "C999", botToken: "enc-token" },
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  readDetectorWindowSummary.mockResolvedValue({
    distinctFindingCount: 5,
    data: {
      d1: { finding_count: 4, run_count: 9, sample_trace_ids: ["trace-d1"] },
      d2: { finding_count: 1, run_count: 3, sample_trace_ids: ["trace-d2"] },
    },
  });
  detectorFindMany.mockResolvedValue([
    { id: "d1", name: "Latency", enableRca: true },
    { id: "d2", name: "Errors", enableRca: true },
  ]);
  projectFindUnique.mockResolvedValue(PROJECT);
  sendDigestAlertSlack.mockResolvedValue(undefined);
  sendDigestAlertEmail.mockResolvedValue(undefined);
  generateDigestSummary.mockResolvedValue(null);
  aiMessageCreate.mockResolvedValue(undefined);
});

async function run() {
  const { flushDigest } = await import("../detector-digest-processor.js");
  await flushDigest({ projectId: "p1", windowStart: 0, windowMs: 1_800_000 });
}

describe("flushDigest", () => {
  it("counts a finding shared by multiple detectors once in the digest header", async () => {
    readDetectorWindowSummary.mockResolvedValue({
      distinctFindingCount: 1,
      data: {
        d1: { finding_count: 1, run_count: 1, sample_trace_ids: ["trace-shared"] },
        d2: { finding_count: 1, run_count: 1, sample_trace_ids: ["trace-shared"] },
      },
    });

    await run();

    const slackArg = sendDigestAlertSlack.mock.calls[0][0];
    expect(slackArg.total).toBe(1);
    expect(slackArg.entries).toEqual([
      {
        detectorId: "d1",
        detectorName: "Latency",
        findingCount: 1,
        latestTraceId: "trace-shared",
      },
      {
        detectorId: "d2",
        detectorName: "Errors",
        findingCount: 1,
        latestTraceId: "trace-shared",
      },
    ]);
  });

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
    readDetectorWindowSummary.mockResolvedValue({
      distinctFindingCount: 4,
      data: { d1: { finding_count: 4, run_count: 9, sample_trace_ids: ["trace-d1"] } },
    });

    await run();

    const slackArg = sendDigestAlertSlack.mock.calls[0][0];
    expect(slackArg.entries).toHaveLength(1);
    expect(slackArg.entries[0].detectorId).toBe("d1");
    expect(slackArg.total).toBe(4);
    expect(detectorFindMany).toHaveBeenCalledWith({
      where: { projectId: "p1", enableRca: true },
      select: { id: true, name: true, enableRca: true },
    });
    expect(readDetectorWindowSummary.mock.calls[0][3].detectorIds).toEqual(["d1"]);
  });

  it("does not count a finding triggered only by an RCA-disabled detector", async () => {
    const allDetectors = [
      { id: "d1", name: "Latency", enableRca: true },
      { id: "d2", name: "Errors", enableRca: false },
    ];
    const allDetectorRows = {
      d1: { finding_count: 0, run_count: 1, sample_trace_ids: [] },
      d2: { finding_count: 1, run_count: 1, sample_trace_ids: ["trace-disabled"] },
    };
    detectorFindMany.mockImplementation(async (query: { where: { enableRca: boolean } }) =>
      allDetectors.filter((detector) => detector.enableRca === query.where.enableRca),
    );
    let returnedDistinctFindingCount: number | undefined;
    readDetectorWindowSummary.mockImplementation(
      async (
        _projectId,
        _start,
        _end,
        opts: { detectorIds?: Array<keyof typeof allDetectorRows> },
      ) => {
        const detectorIds =
          opts.detectorIds ?? (Object.keys(allDetectorRows) as Array<"d1" | "d2">);
        const data = Object.fromEntries(detectorIds.map((id) => [id, allDetectorRows[id]]));
        returnedDistinctFindingCount = detectorIds.includes("d2") ? 1 : 0;
        return { distinctFindingCount: returnedDistinctFindingCount, data };
      },
    );

    await run();

    const requestedDetectorIds = readDetectorWindowSummary.mock.calls[0][3].detectorIds;
    expect(requestedDetectorIds).toEqual(["d1"]);
    expect(requestedDetectorIds).not.toContain("d2");
    expect(returnedDistinctFindingCount).toBe(0);
    expect(sendDigestAlertSlack).not.toHaveBeenCalled();
    expect(sendDigestAlertEmail).not.toHaveBeenCalled();
  });

  it("sends nothing when no detector has findings in the window", async () => {
    readDetectorWindowSummary.mockResolvedValue({
      distinctFindingCount: 0,
      data: {
        d1: { finding_count: 0, run_count: 9, sample_trace_ids: [] },
        d2: { finding_count: 0, run_count: 3, sample_trace_ids: [] },
      },
    });

    await run();

    expect(detectorFindMany).toHaveBeenCalledTimes(1);
    expect(sendDigestAlertSlack).not.toHaveBeenCalled();
    expect(sendDigestAlertEmail).not.toHaveBeenCalled();
  });

  it("sends nothing when only RCA-disabled detectors fired", async () => {
    detectorFindMany.mockResolvedValue([
      { id: "d1", name: "Latency", enableRca: false },
      { id: "d2", name: "Errors", enableRca: false },
    ]);

    await run();

    // Resolve the RCA-enabled scope before reading ClickHouse so an empty scope
    // never falls back to an unfiltered window count.
    expect(readDetectorWindowSummary).not.toHaveBeenCalled();
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

    expect(readDetectorWindowSummary).not.toHaveBeenCalled(); // resolved first, bailed before the summary read
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

    expect(readDetectorWindowSummary).not.toHaveBeenCalled();
    expect(detectorFindMany).not.toHaveBeenCalled();
    expect(sendDigestAlertSlack).not.toHaveBeenCalled();
    expect(sendDigestAlertEmail).not.toHaveBeenCalled();
  });

  it("passes the generated summary to both channels and writes an AIMessage", async () => {
    readDetectorWindowSummary.mockResolvedValue({
      distinctFindingCount: 4,
      data: {
        d1: {
          finding_count: 4,
          run_count: 9,
          sample_trace_ids: ["trace-d1"],
          sample_summaries: ["s1", "s2"],
        },
      },
    });
    detectorFindMany.mockResolvedValue([{ id: "d1", name: "Latency", enableRca: true }]);
    generateDigestSummary.mockResolvedValue({
      summary: "Payments API is down.",
      usage: {
        model: "claude-haiku-4-5",
        provider: "anthropic",
        isByok: false,
        inputTokens: 900,
        outputTokens: 60,
        cost: 0.001,
      },
    });
    await run();
    expect(readDetectorWindowSummary.mock.calls[0][3]).toEqual({
      includeSummaries: true,
      detectorIds: ["d1"],
    });
    expect(generateDigestSummary.mock.calls[0][0].detectors).toEqual([
      { name: "Latency", findingCount: 4, sampleSummaries: ["s1", "s2"] },
    ]);
    expect(sendDigestAlertSlack.mock.calls[0][0].summary).toBe("Payments API is down.");
    expect(sendDigestAlertEmail.mock.calls[0][0].summary).toBe("Payments API is down.");
    expect(aiMessageCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        workspaceId: "ws1",
        kind: "digest-summary",
        model: "claude-haiku-4-5",
        cost: 0.001,
      }),
    });
  });

  it("sends the digest unchanged when summary generation returns null", async () => {
    generateDigestSummary.mockResolvedValue(null);
    await run();
    expect(sendDigestAlertSlack.mock.calls[0][0].summary).toBeUndefined();
    expect(sendDigestAlertEmail.mock.calls[0][0].summary).toBeUndefined();
    expect(aiMessageCreate).not.toHaveBeenCalled();
  });

  it("skips summary generation entirely for rca-blocked free workspaces", async () => {
    projectFindUnique.mockResolvedValue({
      ...PROJECT,
      workspace: { ...PROJECT.workspace, billingPlan: "free", rcaBlocked: true },
    });
    await run();
    expect(generateDigestSummary).not.toHaveBeenCalled();
    // Blocked workspaces also skip the extra ClickHouse summaries join.
    expect(readDetectorWindowSummary.mock.calls[0][3]).toEqual({
      includeSummaries: false,
      detectorIds: ["d1", "d2"],
    });
    expect(sendDigestAlertSlack).toHaveBeenCalledTimes(1); // digest still sends
  });

  it.each(["false", "FALSE", " false "])(
    "skips summary generation when DIGEST_SUMMARY_ENABLED is %j",
    async (value) => {
      // vi.stubEnv restores the pre-test value (set or unset) on unstub.
      vi.stubEnv("DIGEST_SUMMARY_ENABLED", value);
      try {
        await run();
        expect(generateDigestSummary).not.toHaveBeenCalled();
        expect(readDetectorWindowSummary.mock.calls[0][3]).toEqual({
          includeSummaries: false,
          detectorIds: ["d1", "d2"],
        });
        expect(sendDigestAlertSlack).toHaveBeenCalledTimes(1); // digest still sends
      } finally {
        vi.unstubAllEnvs();
      }
    },
  );

  it('leaves summaries enabled for values other than "false" (e.g. "0")', async () => {
    vi.stubEnv("DIGEST_SUMMARY_ENABLED", "0");
    try {
      await run();
      expect(readDetectorWindowSummary.mock.calls[0][3]).toEqual({
        includeSummaries: true,
        detectorIds: ["d1", "d2"],
      });
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
