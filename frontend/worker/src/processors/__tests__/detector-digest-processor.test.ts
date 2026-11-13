import { describe, it, expect, vi, beforeEach } from "vitest";
import type { DetectorWindowSummary } from "../../detection/findings-reader.js";

const readDetectorWindowCounts = vi.fn();
const detectorFindMany = vi.fn();
const projectFindFirst = vi.fn();
const sendDigestAlertSlack = vi.fn();
const sendDigestAlertEmail = vi.fn();
const generateDigestSummary = vi.fn();
const aiMessageCreate = vi.fn();

vi.mock("../../detection/findings-reader.js", () => ({
  readDetectorWindowCounts: (...a: any[]) => readDetectorWindowCounts(...a),
}));

vi.mock("@traceroot/core", () => ({
  prisma: {
    detector: { findMany: (...a: any[]) => detectorFindMany(...a) },
    project: { findFirst: (...a: any[]) => projectFindFirst(...a) },
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

// What the backend returns: the per-detector map plus the distinct finding total.
// With no shared findings the distinct total is just the sum of the per-detector
// counts, which is the default here; pass `distinct` to model co-triggering.
// The endpoint also returns run_count, which the reader's type leaves out.
type Counts = Record<string, DetectorWindowSummary[string] & { run_count: number }>;
const counts = (
  data: Counts,
  distinct: number = Object.values(data).reduce((n, d) => n + d.finding_count, 0),
) => ({ data, distinctFindingCount: distinct });

// A backend that predates the field: no distinct total at all. (Not `counts(data,
// undefined)`: an explicit `undefined` would trigger the default parameter above.)
const withoutTotal = (data: Counts) => ({ data, distinctFindingCount: undefined });

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
  readDetectorWindowCounts.mockResolvedValue(
    counts({
      d1: { finding_count: 4, run_count: 9, sample_trace_ids: ["trace-d1"] },
      d2: { finding_count: 1, run_count: 3, sample_trace_ids: ["trace-d2"] },
    }),
  );
  detectorFindMany.mockResolvedValue([
    { id: "d1", name: "Latency", enableRca: true },
    { id: "d2", name: "Errors", enableRca: true },
  ]);
  projectFindFirst.mockResolvedValue(PROJECT);
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
    // Second read: the distinct total over the reported detector (d1) alone.
    readDetectorWindowCounts.mockResolvedValueOnce(
      counts(
        {
          d1: { finding_count: 4, run_count: 9, sample_trace_ids: ["trace-d1"] },
          d2: { finding_count: 1, run_count: 3, sample_trace_ids: ["trace-d2"] },
        },
        5,
      ),
    );
    readDetectorWindowCounts.mockResolvedValueOnce(
      counts({ d1: { finding_count: 4, run_count: 9, sample_trace_ids: ["trace-d1"] } }, 4),
    );

    await run();

    const slackArg = sendDigestAlertSlack.mock.calls[0][0];
    expect(slackArg.entries).toHaveLength(1);
    expect(slackArg.entries[0].detectorId).toBe("d1");
    expect(slackArg.total).toBe(4);
  });

  it("leaves detectors grouping into signals to the signal digest", async () => {
    detectorFindMany.mockResolvedValue([
      { id: "d1", name: "Latency", enableRca: true, enableSignals: true },
      { id: "d2", name: "Errors", enableRca: true, enableSignals: false },
    ]);
    vi.stubEnv("OPENAI_API_KEY", "sk");
    await run();
    expect(
      sendDigestAlertSlack.mock.calls[0][0].entries.map(
        (e: { detectorId: string }) => e.detectorId,
      ),
    ).toEqual(["d2"]);

    // Without the signals key nothing groups, so the per-finding digest keeps both.
    vi.stubEnv("OPENAI_API_KEY", "");
    sendDigestAlertSlack.mockClear();
    await run();
    expect(sendDigestAlertSlack.mock.calls[0][0].entries).toHaveLength(2);
    vi.unstubAllEnvs();
  });

  it("sends nothing when no detector has findings in the window", async () => {
    readDetectorWindowCounts.mockResolvedValue(
      counts({
        d1: { finding_count: 0, run_count: 9, sample_trace_ids: [] },
        d2: { finding_count: 0, run_count: 3, sample_trace_ids: [] },
      }),
    );

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
    expect(sendDigestAlertSlack).not.toHaveBeenCalled();
    expect(sendDigestAlertEmail).not.toHaveBeenCalled();
  });

  it("skips Slack when no channel is configured but still emails", async () => {
    projectFindFirst.mockResolvedValue({
      ...PROJECT,
      alertConfig: { emailAddresses: ["a@example.com"], slackChannelId: null },
      workspace: { id: "ws1", slackIntegration: null },
    });

    await run();

    expect(sendDigestAlertSlack).not.toHaveBeenCalled();
    expect(sendDigestAlertEmail).toHaveBeenCalledTimes(1);
  });

  it("returns without sending when the project is gone", async () => {
    projectFindFirst.mockResolvedValue(null);

    await run();

    // A soft-deleted project counts as gone.
    expect(projectFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: expect.any(String), deleteTime: null } }),
    );

    expect(readDetectorWindowCounts).not.toHaveBeenCalled(); // resolved first, bailed before the summary read
    expect(sendDigestAlertSlack).not.toHaveBeenCalled();
    expect(sendDigestAlertEmail).not.toHaveBeenCalled();
  });

  it("short-circuits before reading counts when the project has no channels", async () => {
    projectFindFirst.mockResolvedValue({
      name: "Acme Corp",
      alertConfig: { emailAddresses: [], slackChannelId: null },
      workspace: { id: "ws1", slackIntegration: null },
    });

    await run();

    expect(readDetectorWindowCounts).not.toHaveBeenCalled();
    expect(detectorFindMany).not.toHaveBeenCalled();
    expect(sendDigestAlertSlack).not.toHaveBeenCalled();
    expect(sendDigestAlertEmail).not.toHaveBeenCalled();
  });

  it("passes the generated summary to both channels and writes an AIMessage", async () => {
    readDetectorWindowCounts.mockResolvedValue(
      counts({
        d1: {
          finding_count: 4,
          run_count: 9,
          sample_trace_ids: ["trace-d1"],
          sample_summaries: ["s1", "s2"],
        },
      }),
    );
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
    expect(readDetectorWindowCounts.mock.calls[0][3]).toEqual({ includeSummaries: true });
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
    // No self-trace was emitted for this flush: nothing to store.
    expect(aiMessageCreate.mock.calls[0][0].data).not.toHaveProperty("metadata");
  });

  it("stores the flush's trace id on the digest-summary row, so the trace can be found later", async () => {
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
      trace: { traceId: "f".repeat(32) },
    });
    await run();
    expect(aiMessageCreate.mock.calls[0][0].data.metadata).toEqual({
      traceId: "f".repeat(32),
      traceStatus: "available",
    });
  });

  it("keeps the trace id of a flush that produced no summary, and still sends the digest", async () => {
    // The failing attempt emitted a trace and was billed for it; the row exists
    // purely so that trace is reachable afterwards.
    detectorFindMany.mockResolvedValue([{ id: "d1", name: "Latency", enableRca: true }]);
    generateDigestSummary.mockResolvedValue({
      summary: null,
      failure: "timeout",
      trace: { traceId: "a".repeat(32) },
    });
    await run();
    expect(sendDigestAlertSlack.mock.calls[0][0].summary).toBeUndefined();
    expect(sendDigestAlertEmail.mock.calls[0][0].summary).toBeUndefined();
    expect(aiMessageCreate.mock.calls[0][0].data.metadata).toEqual({
      traceId: "a".repeat(32),
      traceStatus: "available",
      failure: "timeout",
    });
    // Nothing resolved, so the row carries no model or usage.
    expect(aiMessageCreate.mock.calls[0][0].data).toMatchObject({
      model: null,
      provider: null,
      inputTokens: null,
      cost: null,
    });
  });

  it("records the usage a summaryless attempt still burned", async () => {
    detectorFindMany.mockResolvedValue([{ id: "d1", name: "Latency", enableRca: true }]);
    generateDigestSummary.mockResolvedValue({
      summary: null,
      failure: "no-summary",
      trace: { traceId: "b".repeat(32) },
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
    expect(aiMessageCreate.mock.calls[0][0].data).toMatchObject({
      kind: "digest-summary",
      model: "claude-haiku-4-5",
      cost: 0.001,
    });
    expect(aiMessageCreate.mock.calls[0][0].data.metadata).toMatchObject({ failure: "no-summary" });
  });

  it("sends the digest unchanged when summary generation returns null", async () => {
    generateDigestSummary.mockResolvedValue(null);
    await run();
    expect(sendDigestAlertSlack.mock.calls[0][0].summary).toBeUndefined();
    expect(sendDigestAlertEmail.mock.calls[0][0].summary).toBeUndefined();
    expect(aiMessageCreate).not.toHaveBeenCalled();
  });

  it("skips summary generation entirely for rca-blocked free workspaces", async () => {
    projectFindFirst.mockResolvedValue({
      ...PROJECT,
      workspace: { ...PROJECT.workspace, billingPlan: "free", rcaBlocked: true },
    });
    await run();
    expect(generateDigestSummary).not.toHaveBeenCalled();
    // Blocked workspaces also skip the extra ClickHouse summaries join.
    expect(readDetectorWindowCounts.mock.calls[0][3]).toEqual({ includeSummaries: false });
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
        expect(readDetectorWindowCounts.mock.calls[0][3]).toEqual({ includeSummaries: false });
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
      expect(readDetectorWindowCounts.mock.calls[0][3]).toEqual({ includeSummaries: true });
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe("flushDigest distinct finding total", () => {
  const trace = (id: string) => ({ finding_count: 1, run_count: 1, sample_trace_ids: [id] });

  it("counts a finding shared by co-triggering detectors once, not once per detector", async () => {
    // Three detectors fire on the same trace and carry the same finding_id.
    readDetectorWindowCounts.mockResolvedValue(
      counts({ d1: trace("t-1"), d2: trace("t-1"), d3: trace("t-1") }, 1),
    );
    detectorFindMany.mockResolvedValue([
      { id: "d1", name: "Failure v1", enableRca: true },
      { id: "d2", name: "Failure v2", enableRca: true },
      { id: "d3", name: "Logic v1", enableRca: true },
    ]);

    await run();

    const slackArg = sendDigestAlertSlack.mock.calls[0][0];
    expect(slackArg.total).toBe(1);
    expect(sendDigestAlertEmail.mock.calls[0][0].total).toBe(1);
    // The per-detector counts are untouched: each detector did flag that finding.
    expect(slackArg.entries.map((e: { findingCount: number }) => e.findingCount)).toEqual([
      1, 1, 1,
    ]);
  });

  it("reads once when every detector that fired is reported", async () => {
    readDetectorWindowCounts.mockResolvedValue(counts({ d1: trace("t-1"), d2: trace("t-1") }, 1));
    detectorFindMany.mockResolvedValue([
      { id: "d1", name: "A", enableRca: true },
      { id: "d2", name: "B", enableRca: true },
    ]);

    await run();

    expect(readDetectorWindowCounts).toHaveBeenCalledTimes(1);
    expect(sendDigestAlertSlack.mock.calls[0][0].total).toBe(1);
  });

  it("ignores detectors that ran without a finding when deciding whether to re-read", async () => {
    readDetectorWindowCounts.mockResolvedValue(
      counts(
        {
          d1: trace("t-1"),
          d2: { finding_count: 0, run_count: 5, sample_trace_ids: [] },
        },
        1,
      ),
    );
    detectorFindMany.mockResolvedValue([{ id: "d1", name: "A", enableRca: true }]);

    await run();

    // d2 produced no finding, so the unscoped distinct total already equals d1's.
    expect(readDetectorWindowCounts).toHaveBeenCalledTimes(1);
    expect(sendDigestAlertSlack.mock.calls[0][0].total).toBe(1);
  });

  it("re-reads the total scoped to the reported detectors when others fired and are dropped", async () => {
    // d1 (reported) and d2 (RCA off) both flagged f-1; d2 alone flagged f-2 and f-3.
    readDetectorWindowCounts
      .mockResolvedValueOnce(
        counts(
          {
            d1: { finding_count: 1, run_count: 2, sample_trace_ids: ["t-1"] },
            d2: { finding_count: 3, run_count: 3, sample_trace_ids: ["t-3"] },
          },
          3,
        ),
      )
      .mockResolvedValueOnce(
        counts({ d1: { finding_count: 1, run_count: 2, sample_trace_ids: ["t-1"] } }, 1),
      );
    detectorFindMany.mockResolvedValue([
      { id: "d1", name: "A", enableRca: true },
      { id: "d2", name: "B", enableRca: false },
    ]);

    await run();

    expect(readDetectorWindowCounts).toHaveBeenCalledTimes(2);
    const [, , , scopedOpts] = readDetectorWindowCounts.mock.calls[1];
    expect(scopedOpts).toEqual({ detectorIds: ["d1"] });
    // Not 3 (everything that fired) and not 4 (1 + 3 summed): the one reported finding.
    expect(sendDigestAlertSlack.mock.calls[0][0].total).toBe(1);
  });

  it("re-reads the total scoped to the reported detectors when others are left to the signal digest", async () => {
    // Signal grouping is the other way a detector that fired is dropped. d1 groups into
    // signals (reported by the signal digest instead); d2 and d3 stay in this digest and
    // share f-1. d1 alone flagged f-9.
    vi.stubEnv("OPENAI_API_KEY", "sk");
    try {
      readDetectorWindowCounts
        .mockResolvedValueOnce(counts({ d1: trace("t-9"), d2: trace("t-1"), d3: trace("t-1") }, 2))
        .mockResolvedValueOnce(counts({ d2: trace("t-1"), d3: trace("t-1") }, 1));
      detectorFindMany.mockResolvedValue([
        { id: "d1", name: "Grouped", enableRca: true, enableSignals: true },
        { id: "d2", name: "B", enableRca: true, enableSignals: false },
        { id: "d3", name: "C", enableRca: true, enableSignals: false },
      ]);

      await run();

      const slackArg = sendDigestAlertSlack.mock.calls[0][0];
      expect(slackArg.entries.map((e: { detectorId: string }) => e.detectorId)).toEqual([
        "d2",
        "d3",
      ]);
      expect(readDetectorWindowCounts).toHaveBeenCalledTimes(2);
      expect(readDetectorWindowCounts.mock.calls[1][3]).toEqual({ detectorIds: ["d2", "d3"] });
      // Not 2 (d1's f-9 plus the shared f-1) and not 2 as the sum of d2 and d3: the one
      // finding the reported detectors share.
      expect(slackArg.total).toBe(1);
      expect(sendDigestAlertEmail.mock.calls[0][0].total).toBe(1);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("does not request the LLM summaries again on the scoped re-read", async () => {
    readDetectorWindowCounts
      .mockResolvedValueOnce(counts({ d1: trace("t-1"), d2: trace("t-2") }, 2))
      .mockResolvedValueOnce(counts({ d1: trace("t-1") }, 1));
    detectorFindMany.mockResolvedValue([
      { id: "d1", name: "A", enableRca: true },
      { id: "d2", name: "B", enableRca: false },
    ]);

    await run();

    expect(readDetectorWindowCounts.mock.calls[0][3]).toEqual({ includeSummaries: true });
    expect(readDetectorWindowCounts.mock.calls[1][3]).toEqual({ detectorIds: ["d1"] });
  });

  it("falls back to the per-detector sum, with a warning, when the backend omits the total", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    readDetectorWindowCounts.mockResolvedValue(
      withoutTotal({ d1: trace("t-1"), d2: trace("t-2") }),
    );
    detectorFindMany.mockResolvedValue([
      { id: "d1", name: "A", enableRca: true },
      { id: "d2", name: "B", enableRca: true },
    ]);

    await run();

    expect(sendDigestAlertSlack.mock.calls[0][0].total).toBe(2);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("distinct finding count"));
    // No scoped re-read can help a backend that does not report the field.
    expect(readDetectorWindowCounts).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it("falls back to the sum of the reported detectors when the scoped re-read omits the total", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    readDetectorWindowCounts
      .mockResolvedValueOnce(counts({ d1: trace("t-1"), d2: trace("t-2") }, 2))
      .mockResolvedValueOnce(withoutTotal({ d1: trace("t-1") }));
    detectorFindMany.mockResolvedValue([
      { id: "d1", name: "A", enableRca: true },
      { id: "d2", name: "B", enableRca: false },
    ]);

    await run();

    // Sum over the REPORTED detectors only (d1), not over everything that fired.
    expect(sendDigestAlertSlack.mock.calls[0][0].total).toBe(1);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("sends nothing, rather than a wrong count, when the scoped re-read fails", async () => {
    readDetectorWindowCounts
      .mockResolvedValueOnce(counts({ d1: trace("t-1"), d2: trace("t-2") }, 2))
      .mockRejectedValueOnce(new Error("Backend API error: 503"));
    detectorFindMany.mockResolvedValue([
      { id: "d1", name: "A", enableRca: true },
      { id: "d2", name: "B", enableRca: false },
    ]);

    await expect(run()).rejects.toThrow("Backend API error: 503");
    expect(sendDigestAlertSlack).not.toHaveBeenCalled();
    expect(sendDigestAlertEmail).not.toHaveBeenCalled();
  });

  it("logs the distinct total", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    readDetectorWindowCounts.mockResolvedValue(counts({ d1: trace("t-1"), d2: trace("t-1") }, 1));
    detectorFindMany.mockResolvedValue([
      { id: "d1", name: "A", enableRca: true },
      { id: "d2", name: "B", enableRca: true },
    ]);

    await run();

    expect(log).toHaveBeenCalledWith(expect.stringContaining("findings=1 detectors=2"));
    log.mockRestore();
  });
});
