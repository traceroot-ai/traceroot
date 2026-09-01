import { beforeEach, describe, expect, it, vi } from "vitest";

// Task 12: processRcaJob must allocate an execution before the agent runs,
// pass its trace id to the agent, and ack the resulting trace status after.
//
// NOTE on approach (deviation from the plan's original sketch): the plan's
// test mocked `../detector-rca-processor.js` itself and imported
// `processRcaJob`/`runRcaSession` from that mock, expecting the mocked
// `runRcaSession` to be called. That doesn't work under ESM: a module's
// internal call to its own `runRcaSession` binding is NOT redirected by
// mocking the module's own namespace object from the outside — intra-module
// calls bypass the exported binding entirely. So this test instead runs the
// REAL `processRcaJob` and REAL `runRcaSession`, and stubs `fetch` to fake
// the two HTTP round-trips to the agent service (session create + message
// SSE stream), which exercises the new `trace` SSE frame consumer for real.
const allocateExecution = vi.fn();
const advanceLatest = vi.fn();
const setExecutionTraceStatus = vi.fn();
const workspaceFindUnique = vi.fn();
const projectFindUnique = vi.fn();
const gitHubInstallationCount = vi.fn();
const detectorRcaUpsert = vi.fn();
const detectorRcaUpdate = vi.fn();
const detectorRcaExecutionUpdate = vi.fn();
const digestQueueAdd = vi.fn();
const isLatestExecution = vi.fn().mockResolvedValue(true);

vi.mock("@traceroot/core/rca-executions", () => ({
  allocateExecution: (...a: unknown[]) => allocateExecution(...a),
  advanceLatest: (...a: unknown[]) => advanceLatest(...a),
  setExecutionTraceStatus: (...a: unknown[]) => setExecutionTraceStatus(...a),
  isLatestExecution: (...a: unknown[]) => isLatestExecution(...a),
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
  allocateExecution: (...a: unknown[]) => allocateExecution(...a),
  advanceLatest: (...a: unknown[]) => advanceLatest(...a),
  setExecutionTraceStatus: (...a: unknown[]) => setExecutionTraceStatus(...a),
  isLatestExecution: (...a: unknown[]) => isLatestExecution(...a),
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

function sseStream(frames: Array<{ event?: string; data: unknown }>) {
  const text = frames
    .map((f) => `${f.event ? `event: ${f.event}\n` : ""}data: ${JSON.stringify(f.data)}\n\n`)
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

beforeEach(() => {
  vi.clearAllMocks();
  allocateExecution.mockResolvedValue({
    executionId: "exec-1",
    attempt: 1,
    traceId: "f".repeat(32),
  });
  advanceLatest.mockResolvedValue(true);
  setExecutionTraceStatus.mockResolvedValue(undefined);
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
  it("allocates before running, passes the trace id to the agent, acks after", async () => {
    mockFetch
      .mockResolvedValueOnce({ ok: true, json: async () => ({ id: "s1" }) })
      .mockResolvedValueOnce(
        sseStream([textDeltaFrame, { event: "trace", data: { status: "available" } }]),
      );

    const { processRcaJob } = await import("../detector-rca-processor.js");
    await processRcaJob({
      data: {
        findingId: "f1",
        projectId: "p1",
        traceId: "t1",
        workspaceId: "w1",
        findings: [{ detectorId: "d1", detectorName: "det1", summary: "s" }],
        findingTimestamp: 1,
      },
    } as any);

    expect(allocateExecution).toHaveBeenCalledWith(expect.anything(), {
      findingId: "f1",
      projectId: "p1",
    });

    const order = [allocateExecution, setExecutionTraceStatus, advanceLatest].map(
      (f) => f.mock.invocationCallOrder[0],
    );
    expect(order).toEqual([...order].sort((a, b) => a - b));

    // The session-create request carries the execution id...
    const sessionBody = JSON.parse(mockFetch.mock.calls[0][1].body as string);
    expect(sessionBody.executionId).toBe("exec-1");

    // ...and the message request carries the agentTrace with the allocated trace id.
    const msgBody = JSON.parse(mockFetch.mock.calls[1][1].body as string);
    expect(msgBody.agentTrace).toMatchObject({ traceId: "f".repeat(32), kind: "rca" });

    expect(setExecutionTraceStatus).toHaveBeenCalledWith(expect.anything(), "exec-1", "available");
    expect(advanceLatest).toHaveBeenCalledWith(expect.anything(), {
      findingId: "f1",
      executionId: "exec-1",
      attempt: 1,
    });
  });

  it("marks the execution failed and still rethrows when the agent errors after allocation", async () => {
    mockFetch
      .mockResolvedValueOnce({ ok: true, json: async () => ({ id: "s1" }) })
      .mockResolvedValueOnce(sseStream([{ event: "error", data: { message: "agent down" } }]));

    const { processRcaJob } = await import("../detector-rca-processor.js");
    await expect(
      processRcaJob({
        data: {
          findingId: "f1",
          projectId: "p1",
          traceId: "t1",
          workspaceId: "w1",
          findings: [{ detectorId: "d1", detectorName: "det1", summary: "s" }],
          findingTimestamp: 1,
        },
      } as any),
    ).rejects.toThrow(/agent down/);

    expect(setExecutionTraceStatus).toHaveBeenCalledWith(expect.anything(), "exec-1", "failed");
  });

  it("a superseded attempt records its own failure but leaves the finding alone", async () => {
    // A slow older attempt can finish after a newer one already succeeded. Its
    // failure belongs to its own execution row; writing it to the shared
    // finding row would overwrite the newer attempt's result.
    isLatestExecution.mockResolvedValueOnce(false);
    mockFetch
      .mockResolvedValueOnce({ ok: true, json: async () => ({ id: "s1" }) })
      .mockResolvedValueOnce(sseStream([{ event: "error", data: { message: "agent down" } }]));

    const { processRcaJob } = await import("../detector-rca-processor.js");
    await expect(
      processRcaJob({
        data: {
          findingId: "f1",
          projectId: "p1",
          traceId: "t1",
          workspaceId: "w1",
          findings: [{ detectorId: "d1", detectorName: "det1", summary: "s" }],
          findingTimestamp: 1,
        },
      } as any),
    ).rejects.toThrow(/agent down/);

    // Its own execution row still records the failure...
    expect(detectorRcaExecutionUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "exec-1" } }),
    );
    // ...but the finding, owned by the newer attempt, is untouched.
    expect(detectorRcaUpdate).not.toHaveBeenCalled();
  });
});
