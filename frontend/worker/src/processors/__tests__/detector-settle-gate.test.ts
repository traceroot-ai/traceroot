import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Job } from "bullmq";
import type { DetectorRunJob } from "../../queues/detector-run-queue.js";

const { mockRunDetection, mockWriteRun, mockWriteFinding, mockRedisSet, mockQueueAdd, mockPrisma } =
  vi.hoisted(() => ({
    mockRunDetection: vi.fn(),
    mockWriteRun: vi.fn(),
    mockWriteFinding: vi.fn(),
    mockRedisSet: vi.fn(),
    mockQueueAdd: vi.fn(),
    mockPrisma: {
      detector: { findMany: vi.fn() },
      project: { findUnique: vi.fn() },
      aIMessage: { createMany: vi.fn() },
      detectorRca: { upsert: vi.fn() },
    },
  }));

vi.mock("bullmq", () => {
  class MockQueue {
    add = mockQueueAdd;
  }
  class DelayedError extends Error {}
  return { Worker: vi.fn(), Queue: MockQueue, DelayedError };
});

vi.mock("@traceroot/core", () => ({
  prisma: mockPrisma,
  PlanType: { FREE: "free", PRO: "pro" },
}));

vi.mock("../../queues/detector-run-queue.js", () => ({
  DETECTOR_RUN_QUEUE: "detector-run",
  DETECTOR_RCA_QUEUE: "detector-rca",
  createRedisConnection: () => ({ set: mockRedisSet }),
}));

vi.mock("../../detection/sandbox-eval.js", () => ({
  runDetectionForTrace: mockRunDetection,
}));

vi.mock("../../detection/clickhouse-writer.js", () => ({
  writeDetectorRun: mockWriteRun,
  writeDetectorFinding: mockWriteFinding,
}));

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

import { DelayedError } from "bullmq";
import {
  decideSettleAction,
  handleDetectorRunJob,
  processTrace,
  traceFindingId,
  QUIESCENCE_SECONDS,
  MAX_WAIT_MS,
  NO_PROGRESS_LIMIT,
  type SettleStatus,
  type SettleDecision,
} from "../detector-run-processor.js";

function settle(over: Partial<SettleStatus> = {}): SettleStatus {
  return {
    root_present: true,
    span_count: 5,
    dangling_count: 0,
    dangling_hash: "",
    last_arrival_age_seconds: QUIESCENCE_SECONDS + 5,
    ...over,
  };
}

const BASE_JOB: DetectorRunJob = {
  traceId: "trace-1",
  detectorIds: ["det-1"],
  projectId: "proj-1",
};

function asBounce(d: SettleDecision): Extract<SettleDecision, { action: "bounce" }> {
  if (d.action !== "bounce") throw new Error(`expected bounce, got ${d.action}`);
  return d;
}

describe("decideSettleAction", () => {
  it("evaluates with no partialReason when the trace has settled", () => {
    const d = decideSettleAction(settle(), BASE_JOB, 60_000);
    expect(d).toEqual({ action: "evaluate", partialReason: null });
  });

  it("bounces a fresh unsettled job with the first delay and records the dangling hash", () => {
    const d = asBounce(
      decideSettleAction(
        settle({ dangling_count: 2, dangling_hash: "h1", last_arrival_age_seconds: 5 }),
        BASE_JOB,
        1_000,
      ),
    );
    expect(d.delayMs).toBe(30_000);
    expect(d.nextData.bounces).toBe(1);
    expect(d.nextData.lastDanglingHash).toBe("h1");
    expect(d.nextData.sameHashCount).toBe(0);
  });

  it("backs off 30s -> 60s -> 120s then stays at 120s", () => {
    const unsettled = settle({ root_present: false, last_arrival_age_seconds: 1 });
    const delays = [0, 1, 2, 3, 10].map(
      (bounces) => asBounce(decideSettleAction(unsettled, { ...BASE_JOB, bounces }, 0)).delayMs,
    );
    expect(delays).toEqual([30_000, 60_000, 120_000, 120_000, 120_000]);
  });

  it("evaluates with cap_expired once MAX_WAIT_MS has elapsed", () => {
    const d = decideSettleAction(
      settle({ dangling_count: 3, last_arrival_age_seconds: 1 }),
      BASE_JOB,
      MAX_WAIT_MS,
    );
    expect(d).toEqual({ action: "evaluate", partialReason: "cap_expired" });
  });

  it("evaluates at the cap even when the root span never arrived", () => {
    const d = decideSettleAction(
      settle({ root_present: false, last_arrival_age_seconds: 500 }),
      BASE_JOB,
      MAX_WAIT_MS + 1,
    );
    expect(d).toEqual({ action: "evaluate", partialReason: "cap_expired" });
  });

  it("evaluates with no_progress after NO_PROGRESS_LIMIT consecutive quiet same-hash checks", () => {
    const stuck = settle({
      dangling_count: 1,
      dangling_hash: "h-stuck",
      last_arrival_age_seconds: QUIESCENCE_SECONDS,
    });
    let data = { ...BASE_JOB };
    // First check records the hash (no previous hash to match).
    data = asBounce(decideSettleAction(stuck, data, 0)).nextData;
    expect(data.sameHashCount).toBe(0);
    // Matching checks increment the counter until the limit triggers evaluation.
    for (let i = 1; i < NO_PROGRESS_LIMIT; i++) {
      data = asBounce(decideSettleAction(stuck, data, 0)).nextData;
      expect(data.sameHashCount).toBe(i);
    }
    const d = decideSettleAction(stuck, data, 0);
    expect(d).toEqual({ action: "evaluate", partialReason: "no_progress" });
  });

  it("resets the no-progress counter when the dangling hash changes", () => {
    const quiet = { dangling_count: 1, last_arrival_age_seconds: QUIESCENCE_SECONDS + 1 };
    const primed = { ...BASE_JOB, lastDanglingHash: "h1", sameHashCount: 2, bounces: 3 };
    const d = asBounce(decideSettleAction(settle({ ...quiet, dangling_hash: "h2" }), primed, 0));
    expect(d.nextData.sameHashCount).toBe(0);
    expect(d.nextData.lastDanglingHash).toBe("h2");
  });

  it("keeps bouncing without counting when spans are still arriving (age < quiescence)", () => {
    const primed = { ...BASE_JOB, lastDanglingHash: "h1", sameHashCount: 2 };
    const d = asBounce(
      decideSettleAction(
        settle({ dangling_count: 1, dangling_hash: "h1", last_arrival_age_seconds: 3 }),
        primed,
        0,
      ),
    );
    expect(d.nextData.sameHashCount).toBe(0);
  });

  it("bounces when the root is missing even with zero dangling spans", () => {
    const d = decideSettleAction(settle({ root_present: false }), BASE_JOB, 0);
    expect(d.action).toBe("bounce");
  });
});

// --- Shared fixtures for the imperative paths -------------------------------

const SPANS_JSONL = '{"span":1}\n{"span":2}\n\n';
const FINDING_ID = traceFindingId("proj-1", "trace-1");

function evalResult(identified: boolean) {
  return {
    identified,
    summary: identified ? "found the problem" : "clean",
    data: {},
    inferenceCost: 0.001,
    inferenceInputTokens: 10,
    inferenceOutputTokens: 5,
    inferenceSource: "system",
    inferenceModel: "test-model",
    inferenceProvider: "anthropic",
  };
}

let settleStatus: SettleStatus;
let existingFindings: Array<{ finding_id: string }>;

function installFetchRoutes() {
  mockFetch.mockImplementation((url: string) => {
    if (url.includes("/settle-status")) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve(settleStatus) });
    }
    if (url.includes("/spans-jsonl")) {
      return Promise.resolve({ ok: true, text: () => Promise.resolve(SPANS_JSONL) });
    }
    if (url.includes("/findings")) {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ findings: existingFindings }),
      });
    }
    return Promise.reject(new Error(`unexpected fetch: ${url}`));
  });
}

function makeJob(data: Partial<DetectorRunJob> = {}, timestamp = Date.now()) {
  const job = {
    data: { ...BASE_JOB, ...data },
    timestamp,
    updateData: vi.fn(async (d: DetectorRunJob) => {
      job.data = d;
    }),
    moveToDelayed: vi.fn().mockResolvedValue(undefined),
  };
  return job as unknown as Job<DetectorRunJob> & {
    updateData: ReturnType<typeof vi.fn>;
    moveToDelayed: ReturnType<typeof vi.fn>;
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  settleStatus = settle();
  existingFindings = [];
  installFetchRoutes();
  mockRunDetection.mockResolvedValue(evalResult(false));
  mockWriteRun.mockResolvedValue(undefined);
  mockWriteFinding.mockResolvedValue(undefined);
  mockRedisSet.mockResolvedValue("OK");
  mockQueueAdd.mockResolvedValue(undefined);
  mockPrisma.detector.findMany.mockResolvedValue([
    {
      id: "det-1",
      name: "error detector",
      prompt: "detect errors",
      outputSchema: [],
      detectionModel: null,
      detectionProvider: null,
      detectionSource: "system",
      enableRca: true,
      enabled: true,
    },
  ]);
  mockPrisma.project.findUnique.mockResolvedValue({
    name: "proj",
    workspaceId: "ws-1",
    workspace: { billingPlan: "pro", detectorBlocked: false },
  });
  mockPrisma.aIMessage.createMany.mockResolvedValue({ count: 1 });
  mockPrisma.detectorRca.upsert.mockResolvedValue({});
});

describe("handleDetectorRunJob", () => {
  it("bounces an unsettled job: updates data, moves to delayed, throws DelayedError", async () => {
    settleStatus = settle({ dangling_count: 2, dangling_hash: "h1", last_arrival_age_seconds: 4 });
    const now = Date.now();
    const job = makeJob({}, now);

    await expect(handleDetectorRunJob(job, "tok")).rejects.toBeInstanceOf(DelayedError);

    expect(job.updateData).toHaveBeenCalledWith(
      expect.objectContaining({ bounces: 1, lastDanglingHash: "h1", sameHashCount: 0 }),
    );
    const [delayedUntil, token] = job.moveToDelayed.mock.calls[0];
    expect(delayedUntil).toBeGreaterThanOrEqual(now + 30_000);
    expect(delayedUntil).toBeLessThan(now + 40_000);
    expect(token).toBe("tok");
    // Evaluation must not have started.
    expect(mockRunDetection).not.toHaveBeenCalled();
    expect(mockRedisSet).not.toHaveBeenCalled();
  });

  it("evaluates a settled job end to end", async () => {
    await handleDetectorRunJob(makeJob(), "tok");
    expect(mockRunDetection).toHaveBeenCalledTimes(1);
    expect(mockRunDetection.mock.calls[0][0]).toMatchObject({ partialReason: null });
    expect(mockRedisSet).toHaveBeenCalledTimes(1);
  });

  it("passes cap_expired through to the eval when forced by the wait cap", async () => {
    settleStatus = settle({ dangling_count: 1, last_arrival_age_seconds: 1 });
    await handleDetectorRunJob(makeJob({}, Date.now() - MAX_WAIT_MS - 1), "tok");
    expect(mockRunDetection.mock.calls[0][0]).toMatchObject({ partialReason: "cap_expired" });
  });

  it("passes no_progress through to the eval when the dangling set stops changing", async () => {
    settleStatus = settle({
      dangling_count: 1,
      dangling_hash: "h-stuck",
      last_arrival_age_seconds: QUIESCENCE_SECONDS,
    });
    await handleDetectorRunJob(
      makeJob({ lastDanglingHash: "h-stuck", sameHashCount: NO_PROGRESS_LIMIT - 1 }),
      "tok",
    );
    expect(mockRunDetection.mock.calls[0][0]).toMatchObject({ partialReason: "no_progress" });
  });

  it("throws on a settle-status fetch failure so BullMQ retries", async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 503 });
    const job = makeJob();
    await expect(handleDetectorRunJob(job, "tok")).rejects.toThrow(/settle status/);
    expect(job.moveToDelayed).not.toHaveBeenCalled();
  });

  it("returns without fetching when the job has no detector ids", async () => {
    await handleDetectorRunJob(makeJob({ detectorIds: [] }), "tok");
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

describe("processTrace post-eval state", () => {
  it("writes the evaluated lock state with the non-empty span line count", async () => {
    await processTrace("trace-1", "proj-1", ["det-1"], { partialReason: null, isReeval: false });

    expect(mockRedisSet).toHaveBeenCalledTimes(1);
    const [key, value, exFlag, ttl] = mockRedisSet.mock.calls[0];
    expect(key).toBe("detector-enq:proj-1:trace-1");
    expect(JSON.parse(value)).toEqual({
      state: "evaluated",
      detector_ids: ["det-1"],
      span_count: 2,
      reevals: 0,
    });
    expect(exFlag).toBe("EX");
    expect(ttl).toBe(3600);
  });

  it("writes reevals=1 for a re-evaluation job", async () => {
    await processTrace("trace-1", "proj-1", ["det-1"], { partialReason: null, isReeval: true });
    expect(JSON.parse(mockRedisSet.mock.calls[0][1]).reevals).toBe(1);
  });

  it("does not write the lock state when the spans download fails", async () => {
    mockFetch.mockImplementation((url: string) => {
      if (url.includes("/spans-jsonl")) return Promise.resolve({ ok: false, status: 500 });
      return Promise.reject(new Error(`unexpected fetch: ${url}`));
    });
    await processTrace("trace-1", "proj-1", ["det-1"], { partialReason: null, isReeval: false });
    expect(mockRedisSet).not.toHaveBeenCalled();
    expect(mockWriteRun).toHaveBeenCalledWith(expect.objectContaining({ status: "failed" }));
  });
});

describe("processTrace triggered path", () => {
  beforeEach(() => {
    mockRunDetection.mockResolvedValue(evalResult(true));
  });

  it("writes the finding and spawns RCA on a first evaluation", async () => {
    await processTrace("trace-1", "proj-1", ["det-1"], { partialReason: null, isReeval: false });

    expect(mockWriteFinding).toHaveBeenCalledTimes(1);
    const finding = mockWriteFinding.mock.calls[0][0];
    expect(finding.findingId).toBe(FINDING_ID);
    expect(finding.retracted).toBeUndefined();
    expect(JSON.parse(finding.payload)[0]).not.toHaveProperty("partial");
    expect(mockPrisma.detectorRca.upsert).toHaveBeenCalledTimes(1);
    expect(mockQueueAdd).toHaveBeenCalledTimes(1);
  });

  it("marks every payload entry partial when evaluation was forced early", async () => {
    await processTrace("trace-1", "proj-1", ["det-1"], {
      partialReason: "cap_expired",
      isReeval: false,
    });
    const payload = JSON.parse(mockWriteFinding.mock.calls[0][0].payload);
    expect(payload.every((entry: { partial?: boolean }) => entry.partial === true)).toBe(true);
  });

  it("re-eval overwrites the finding but spawns no second RCA", async () => {
    await processTrace("trace-1", "proj-1", ["det-1"], { partialReason: null, isReeval: true });

    expect(mockWriteFinding).toHaveBeenCalledTimes(1);
    expect(mockWriteFinding.mock.calls[0][0].findingId).toBe(FINDING_ID);
    expect(mockPrisma.detectorRca.upsert).not.toHaveBeenCalled();
    expect(mockQueueAdd).not.toHaveBeenCalled();
  });
});

describe("processTrace clean re-eval retraction", () => {
  it("writes a retraction tombstone when a prior finding exists", async () => {
    existingFindings = [{ finding_id: FINDING_ID }];

    await processTrace("trace-1", "proj-1", ["det-1"], { partialReason: null, isReeval: true });

    expect(mockWriteFinding).toHaveBeenCalledTimes(1);
    expect(mockWriteFinding).toHaveBeenCalledWith({
      findingId: FINDING_ID,
      projectId: "proj-1",
      traceId: "trace-1",
      summary: "",
      payload: "",
      retracted: true,
    });
  });

  it("writes no tombstone when no prior finding exists", async () => {
    existingFindings = [];
    await processTrace("trace-1", "proj-1", ["det-1"], { partialReason: null, isReeval: true });
    expect(mockWriteFinding).not.toHaveBeenCalled();
  });

  it("skips the tombstone without failing the job when the findings check errors", async () => {
    mockFetch.mockImplementation((url: string) => {
      if (url.includes("/spans-jsonl")) {
        return Promise.resolve({ ok: true, text: () => Promise.resolve(SPANS_JSONL) });
      }
      if (url.includes("/findings")) {
        return Promise.resolve({ ok: false, status: 500 });
      }
      return Promise.reject(new Error(`unexpected fetch: ${url}`));
    });

    await expect(
      processTrace("trace-1", "proj-1", ["det-1"], { partialReason: null, isReeval: true }),
    ).resolves.toBeUndefined();
    expect(mockWriteFinding).not.toHaveBeenCalled();
    // The evaluation still completed, so the post-eval state is still written.
    expect(mockRedisSet).toHaveBeenCalledTimes(1);
  });

  it("does not check for prior findings on a clean first evaluation", async () => {
    await processTrace("trace-1", "proj-1", ["det-1"], { partialReason: null, isReeval: false });
    const findingsCalls = mockFetch.mock.calls.filter((c) => String(c[0]).includes("/findings"));
    expect(findingsCalls).toHaveLength(0);
    expect(mockWriteFinding).not.toHaveBeenCalled();
  });
});
