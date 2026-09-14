import { beforeEach, describe, expect, it, vi } from "vitest";

// processRcaJob must allocate an execution before the agent runs, pass its
// trace id to the agent, and record the resulting trace status after — with
// every write to the shared finding row gated on the attempt still being the
// latest.
//
// NOTE on approach: a module's internal call to its own `runRcaSession`
// binding is NOT redirected by mocking the module's namespace from the outside
// (intra-module calls bypass the exported binding under ESM). So this test runs
// the REAL `processRcaJob` and REAL `runRcaSession`, and stubs `fetch` to fake
// the two HTTP round-trips to the agent service (session create + message SSE
// stream), which exercises the `trace` SSE frame consumer for real.
const allocateExecution = vi.fn();
const finishFindingIfLatest = vi.fn();
const markFindingRunningIfLatest = vi.fn();
const workspaceFindUnique = vi.fn();
const projectFindUnique = vi.fn();
const gitHubInstallationCount = vi.fn();
const detectorRcaUpsert = vi.fn();
const detectorRcaUpdate = vi.fn();
const detectorRcaExecutionUpdate = vi.fn();
const digestQueueAdd = vi.fn();

vi.mock("@traceroot/core/rca-executions", () => ({
  allocateExecution: (...a: unknown[]) => allocateExecution(...a),
  finishFindingIfLatest: (...a: unknown[]) => finishFindingIfLatest(...a),
  markFindingRunningIfLatest: (...a: unknown[]) => markFindingRunningIfLatest(...a),
}));
vi.mock("@traceroot/core", async (orig) => ({
  ...(await orig<any>()),
  prisma: {
    workspace: { findUnique: (...a: unknown[]) => workspaceFindUnique(...a) },
    project: { findUnique: (...a: unknown[]) => projectFindUnique(...a) },
    gitHubInstallation: { count: (...a: unknown[]) => gitHubInstallationCount(...a) },
    detectorRca: {
      upsert: (...a: unknown[]) => detectorRcaUpsert(...a),
      update: (...a: unknown[]) => detectorRcaUpdate(...a),
    },
    detectorRcaExecution: { update: (...a: unknown[]) => detectorRcaExecutionUpdate(...a) },
  },
}));

// Real createRedisConnection() opens an ioredis connection — never call it.
vi.mock("../../queues/detector-run-queue.js", async (orig) => ({
  ...(await orig<any>()),
  createRedisConnection: () => ({}),
}));
vi.mock("../../queues/digest-queue.js", async (orig) => ({
  ...(await orig<any>()),
  createDetectorDigestQueue: () => ({ add: (...a: unknown[]) => digestQueueAdd(...a) }),
}));

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

function sseStream(frames: Array<{ event?: string; data: unknown; raw?: string }>) {
  const text = frames
    .map(
      (f) => `${f.event ? `event: ${f.event}\n` : ""}data: ${f.raw ?? JSON.stringify(f.data)}\n\n`,
    )
    .join("");
  const bytes = new TextEncoder().encode(text);
  let sent = false;
  return {
    ok: true,
    body: {
      getReader: () => ({
        read: async () => {
          if (sent) return { done: true, value: undefined };
          sent = true;
          return { done: false, value: bytes };
        },
      }),
    },
  };
}

const textDeltaFrame = {
  event: "message_update",
  data: {
    type: "message_update",
    assistantMessageEvent: { type: "text_delta", delta: "Root cause: found it." },
  },
};

const job = {
  data: {
    findingId: "f1",
    projectId: "p1",
    traceId: "t1",
    workspaceId: "w1",
    findings: [{ detectorId: "d1", detectorName: "det1", summary: "s" }],
    findingTimestamp: 1,
  },
} as any;

function agentReplies(frames: Array<{ event?: string; data: unknown; raw?: string }>) {
  mockFetch
    .mockResolvedValueOnce({ ok: true, json: async () => ({ id: "s1" }) })
    .mockResolvedValueOnce(sseStream(frames));
}

beforeEach(() => {
  vi.clearAllMocks();
  allocateExecution.mockResolvedValue({
    executionId: "exec-1",
    attempt: 1,
    traceId: "f".repeat(32),
  });
  finishFindingIfLatest.mockResolvedValue(true);
  markFindingRunningIfLatest.mockResolvedValue(true);
  workspaceFindUnique.mockResolvedValue({ billingPlan: "pro", rcaBlocked: false });
  projectFindUnique.mockResolvedValue({
    rcaModel: null,
    rcaProvider: null,
    rcaSource: null,
    alertConfig: null,
  });
  gitHubInstallationCount.mockResolvedValue(0);
  detectorRcaUpsert.mockResolvedValue({});
  detectorRcaUpdate.mockResolvedValue({});
  detectorRcaExecutionUpdate.mockResolvedValue({});
  digestQueueAdd.mockResolvedValue(undefined);
});

describe("processRcaJob execution lifecycle", () => {
  it("allocates, guards running, runs, writes the execution row, then finishes the finding", async () => {
    agentReplies([textDeltaFrame, { event: "trace", data: { status: "available" } }]);

    const { processRcaJob } = await import("../detector-rca-processor.js");
    await processRcaJob(job);

    expect(allocateExecution).toHaveBeenCalledWith(expect.anything(), {
      findingId: "f1",
      projectId: "p1",
    });
    expect(markFindingRunningIfLatest).toHaveBeenCalledWith(expect.anything(), {
      findingId: "f1",
      projectId: "p1",
      attempt: 1,
    });

    const order = [
      allocateExecution,
      markFindingRunningIfLatest,
      mockFetch,
      detectorRcaExecutionUpdate,
      finishFindingIfLatest,
    ].map((f) => f.mock.invocationCallOrder[0]);
    expect(order).toEqual([...order].sort((a, b) => a - b));

    // The session-create request carries the execution id...
    const sessionBody = JSON.parse(mockFetch.mock.calls[0][1].body as string);
    expect(sessionBody.executionId).toBe("exec-1");

    // ...and the message request carries the agentTrace with the allocated trace id.
    const msgBody = JSON.parse(mockFetch.mock.calls[1][1].body as string);
    expect(msgBody.agentTrace).toMatchObject({ traceId: "f".repeat(32), kind: "rca" });

    // Two execution-row writes: the session id, stamped as soon as the agent
    // session is created (so a chat stays reachable even if the run later
    // fails), then the trace outcome, session and end time at completion.
    expect(detectorRcaExecutionUpdate).toHaveBeenCalledTimes(2);
    expect(detectorRcaExecutionUpdate).toHaveBeenNthCalledWith(1, {
      where: { id: "exec-1" },
      data: { sessionId: "s1" },
    });
    expect(detectorRcaExecutionUpdate).toHaveBeenNthCalledWith(2, {
      where: { id: "exec-1" },
      data: { traceStatus: "available", sessionId: "s1", finishedAt: expect.any(Date) },
    });
    // The finding's terminal state goes through the guarded helper only.
    expect(finishFindingIfLatest).toHaveBeenCalledWith(expect.anything(), {
      findingId: "f1",
      attempt: 1,
      status: "done",
      result: "Root cause: found it.",
    });
    expect(detectorRcaUpdate).not.toHaveBeenCalled();
  });

  it("does not set the finding to running from the pre-run upsert", async () => {
    agentReplies([textDeltaFrame, { event: "trace", data: { status: "available" } }]);

    const { processRcaJob } = await import("../detector-rca-processor.js");
    await processRcaJob(job);

    // The upsert only guarantees the row exists for allocation; status is the
    // guarded helper's to write.
    const [{ create, update }] = detectorRcaUpsert.mock.calls[0] as [
      { create: Record<string, unknown>; update: Record<string, unknown> },
    ];
    expect(update).not.toHaveProperty("status");
    expect(create.status).not.toBe("running");
    expect(allocateExecution.mock.invocationCallOrder[0]).toBeGreaterThan(
      detectorRcaUpsert.mock.invocationCallOrder[0],
    );
  });

  it("still runs a superseded attempt, without marking the finding running", async () => {
    markFindingRunningIfLatest.mockResolvedValueOnce(false);
    agentReplies([textDeltaFrame, { event: "trace", data: { status: "available" } }]);

    const { processRcaJob } = await import("../detector-rca-processor.js");
    await processRcaJob(job);

    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(detectorRcaUpdate).not.toHaveBeenCalled();
  });

  it("records failed on the execution when output arrived but no trace frame did", async () => {
    // The agent writes `trace` after persisting the run; a stream cut before
    // that frame says nothing about whether the export happened.
    agentReplies([textDeltaFrame, { event: "done", data: {} }]);

    const { processRcaJob } = await import("../detector-rca-processor.js");
    await processRcaJob(job);

    expect(detectorRcaExecutionUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ traceStatus: "failed" }) }),
    );
  });

  it("treats a malformed trace frame as no frame", async () => {
    agentReplies([textDeltaFrame, { event: "trace", data: null, raw: "{not json" }]);

    const { processRcaJob } = await import("../detector-rca-processor.js");
    await processRcaJob(job);

    expect(detectorRcaExecutionUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ traceStatus: "failed" }) }),
    );
  });

  it("keeps the trace status the agent reported when it is disabled", async () => {
    agentReplies([textDeltaFrame, { event: "trace", data: { status: "disabled" } }]);

    const { processRcaJob } = await import("../detector-rca-processor.js");
    await processRcaJob(job);

    expect(detectorRcaExecutionUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ traceStatus: "disabled" }) }),
    );
  });

  it("a superseded attempt that succeeds keeps its result on its execution row only", async () => {
    finishFindingIfLatest.mockResolvedValueOnce(false);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    agentReplies([textDeltaFrame, { event: "trace", data: { status: "available" } }]);

    const { processRcaJob } = await import("../detector-rca-processor.js");
    await expect(processRcaJob(job)).resolves.toBeUndefined();

    // The session-id write plus the completion write — both against this
    // attempt's own execution row, regardless of which attempt owns the finding.
    expect(detectorRcaExecutionUpdate).toHaveBeenCalledTimes(2);
    expect(detectorRcaUpdate).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringContaining("newer attempt owns the finding"));
    // The digest still goes out: a finding must never fail silently.
    expect(digestQueueAdd).toHaveBeenCalledTimes(1);
    log.mockRestore();
  });

  it("marks the execution failed and still rethrows when the agent errors after allocation", async () => {
    agentReplies([{ event: "error", data: { message: "agent down" } }]);

    const { processRcaJob } = await import("../detector-rca-processor.js");
    await expect(processRcaJob(job)).rejects.toThrow(/agent down/);

    // The session was created before the agent's stream reported failure, and
    // its id is stamped onto the execution row immediately — not only on
    // success — so the RCA route's chat link survives a failed run (it treats
    // the execution row as authoritative over the legacy DetectorRca.sessionId
    // once one exists).
    expect(detectorRcaExecutionUpdate).toHaveBeenCalledWith({
      where: { id: "exec-1" },
      data: { sessionId: "s1" },
    });
    expect(detectorRcaExecutionUpdate).toHaveBeenCalledWith({
      where: { id: "exec-1" },
      data: { traceStatus: "failed", finishedAt: expect.any(Date) },
    });
    expect(finishFindingIfLatest).toHaveBeenCalledWith(expect.anything(), {
      findingId: "f1",
      attempt: 1,
      status: "failed",
      result: "RCA failed: RCA agent failed: agent down",
    });
  });

  it("a superseded attempt records its own failure but leaves the finding alone", async () => {
    // A slow older attempt can finish after a newer one already succeeded. Its
    // failure belongs to its own execution row; the finding write is attempted
    // only through the guarded helper, which the database resolves.
    finishFindingIfLatest.mockResolvedValueOnce(false);
    agentReplies([{ event: "error", data: { message: "agent down" } }]);

    const { processRcaJob } = await import("../detector-rca-processor.js");
    await expect(processRcaJob(job)).rejects.toThrow(/agent down/);

    expect(detectorRcaExecutionUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "exec-1" } }),
    );
    expect(finishFindingIfLatest).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ findingId: "f1", attempt: 1, status: "failed" }),
    );
    expect(detectorRcaUpdate).not.toHaveBeenCalled();
  });

  it("rethrows the agent's error even when the failure writes themselves fail", async () => {
    // First call is the sessionId write inside runRcaSession (succeeds, so the
    // agent's own error is what surfaces); the SECOND call is the catch
    // block's own best-effort write — that one fails, which must not swallow
    // the agent's error.
    detectorRcaExecutionUpdate
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(new Error("db down"));
    finishFindingIfLatest.mockRejectedValueOnce(new Error("db down"));
    agentReplies([{ event: "error", data: { message: "agent down" } }]);

    const { processRcaJob } = await import("../detector-rca-processor.js");
    await expect(processRcaJob(job)).rejects.toThrow(/agent down/);
    expect(digestQueueAdd).toHaveBeenCalledTimes(1);
  });
});
