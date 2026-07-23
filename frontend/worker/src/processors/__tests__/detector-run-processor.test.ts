import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Job } from "bullmq";
import type { DetectorRunJob } from "../../queues/detector-run-queue.js";

const EVALUATOR_DELAY = 60_000;

const {
  mockRunDetection,
  mockWriteRun,
  mockWriteFinding,
  mockQueueAdd,
  mockPrisma,
  mockCalculateCost,
  mockWithSelfTrace,
} = vi.hoisted(() => ({
  mockRunDetection: vi.fn(),
  mockWriteRun: vi.fn(),
  mockWriteFinding: vi.fn(),
  mockQueueAdd: vi.fn(),
  mockCalculateCost: vi.fn(),
  mockWithSelfTrace: vi.fn(),
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
  calculateCost: mockCalculateCost,
}));

vi.mock("../../queues/detector-run-queue.js", () => ({
  DETECTOR_RUN_QUEUE: "detector-run",
  DETECTOR_RCA_QUEUE: "detector-rca",
  EVALUATOR_DELAY: 60_000,
  createRedisConnection: () => ({}),
}));

vi.mock("../../detection/sandbox-eval.js", () => ({ runDetectionForTrace: mockRunDetection }));
vi.mock("../../detection/clickhouse-writer.js", () => ({
  writeDetectorRun: mockWriteRun,
  writeDetectorFinding: mockWriteFinding,
}));
vi.mock("../../detection/self-trace-emitter.js", () => ({
  withSelfTrace: mockWithSelfTrace,
}));

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

import { DelayedError } from "bullmq";
import { handleDetectorRunJob, processTrace } from "../detector-run-processor.js";

const BASE_JOB: DetectorRunJob = { traceId: "t1", detectorIds: ["d1"], projectId: "p1" };

/** Make the time-since-last-span fetch report `ms` of quiet; spans-jsonl returns `spans`. */
function mockFetches(ms: number, spans = "") {
  mockFetch.mockImplementation((url: string) => {
    if (String(url).includes("/time-since-last-span")) {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ time_since_last_span_ms: ms }),
      });
    }
    return Promise.resolve({ ok: true, text: () => Promise.resolve(spans) });
  });
}

function makeJob(over: Partial<Job<DetectorRunJob>> = {}): Job<DetectorRunJob> {
  return { data: BASE_JOB, moveToDelayed: vi.fn(), ...over } as unknown as Job<DetectorRunJob>;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockPrisma.detector.findMany.mockResolvedValue([]);
  mockPrisma.project.findUnique.mockResolvedValue({
    name: "P",
    workspaceId: "w1",
    workspace: { billingPlan: "pro", detectorBlocked: false },
  });
  // The production code chains `.catch` on these side-effects, so the mocks
  // must return resolved promises rather than the default `undefined`.
  mockWriteRun.mockResolvedValue(undefined);
  mockWriteFinding.mockResolvedValue(undefined);
  mockQueueAdd.mockResolvedValue(undefined);
  mockCalculateCost.mockResolvedValue(0);
  mockPrisma.aIMessage.createMany.mockResolvedValue(undefined);
  mockPrisma.detectorRca.upsert.mockResolvedValue(undefined);
  // Default: tracing works — run fn once, report selfTraced, surface throws
  // as ok:false (mirrors the real withSelfTrace contract).
  mockWithSelfTrace.mockImplementation(async (_meta: unknown, fn: () => Promise<unknown>) => {
    try {
      return { ok: true, value: await fn(), selfTraced: true };
    } catch (error) {
      return { ok: false, error, selfTraced: true };
    }
  });
});

describe("handleDetectorRunJob — quiescence gate", () => {
  it("evaluates when the trace has been quiet >= EVALUATOR_DELAY", async () => {
    mockFetches(60_000); // quiet 60s == EVALUATOR_DELAY
    const job = makeJob();
    await handleDetectorRunJob(job);
    expect(job.moveToDelayed).not.toHaveBeenCalled();
    // processTrace ran → it downloaded spans-jsonl
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining("/spans-jsonl"),
      expect.anything(),
    );
  });

  it("re-delays to exactly EVALUATOR_DELAY after the last span when not quiet", async () => {
    mockFetches(21_000); // quiet 21s → re-check in 39s
    const job = makeJob();
    const before = Date.now();
    await expect(handleDetectorRunJob(job, "tok")).rejects.toBeInstanceOf(DelayedError);
    expect(job.moveToDelayed).toHaveBeenCalledTimes(1);
    const at = (job.moveToDelayed as ReturnType<typeof vi.fn>).mock.calls[0][0] as number;
    const remaining = EVALUATOR_DELAY - 21_000;
    expect(at).toBeGreaterThanOrEqual(before + remaining);
    expect(at).toBeLessThan(before + remaining + 2_000);
    // did NOT evaluate
    expect(mockFetch).not.toHaveBeenCalledWith(
      expect.stringContaining("/spans-jsonl"),
      expect.anything(),
    );
  });

  it("returns without fetching when the job has no detector ids", async () => {
    const job = makeJob({ data: { ...BASE_JOB, detectorIds: [] } });
    await handleDetectorRunJob(job);
    expect(mockFetch).not.toHaveBeenCalled();
    expect(job.moveToDelayed).not.toHaveBeenCalled();
  });

  it("throws (for BullMQ retry) when time-since-last-span fetch fails", async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 500 });
    await expect(handleDetectorRunJob(makeJob())).rejects.toThrow();
  });
});

describe("processTrace — finding + RCA", () => {
  it("writes a finding, runs, and an RCA job when a detector triggers", async () => {
    mockFetches(60_000, '{"span":1}\n');
    mockPrisma.detector.findMany.mockResolvedValue([
      {
        id: "d1",
        name: "Slow",
        prompt: "p",
        outputSchema: [],
        detectionModel: null,
        detectionProvider: null,
        detectionSource: "system",
        enableRca: true,
      },
    ]);
    mockRunDetection.mockResolvedValue({
      identified: true,
      summary: "found it",
      data: {},
      inferenceCost: 0,
      inferenceInputTokens: 0,
      inferenceOutputTokens: 0,
      inferenceSource: "system",
      inferenceModel: "m",
      inferenceProvider: "anthropic",
    });

    await processTrace("t1", "p1", ["d1"]);

    expect(mockWriteFinding).toHaveBeenCalledTimes(1);
    // never passes a `retracted` flag anymore
    expect(mockWriteFinding.mock.calls[0][0]).not.toHaveProperty("retracted");
    expect(mockWriteRun).toHaveBeenCalled();
    expect(mockQueueAdd).toHaveBeenCalledTimes(1); // one RCA job

    // The finding row, its triggered run, and the RCA job that keys the digest
    // flush all carry the SAME capture time, so the count window the flush reads
    // matches the window the key selects (no clock-boundary skew).
    const ts = mockWriteFinding.mock.calls[0][0].timestampMs;
    expect(typeof ts).toBe("number");
    expect(mockWriteRun.mock.calls[0][0].timestampMs).toBe(ts);
    expect(mockQueueAdd.mock.calls[0][1].findingTimestamp).toBe(ts);
  });

  it("writes no finding when nothing triggers", async () => {
    mockFetches(60_000, '{"span":1}\n');
    mockPrisma.detector.findMany.mockResolvedValue([
      {
        id: "d1",
        name: "Slow",
        prompt: "p",
        outputSchema: [],
        detectionModel: null,
        detectionProvider: null,
        detectionSource: "system",
        enableRca: true,
      },
    ]);
    mockRunDetection.mockResolvedValue({
      identified: false,
      summary: "clean",
      data: {},
      inferenceCost: 0,
      inferenceInputTokens: 0,
      inferenceOutputTokens: 0,
      inferenceSource: "system",
      inferenceModel: "m",
      inferenceProvider: "anthropic",
    });

    await processTrace("t1", "p1", ["d1"]);

    expect(mockWriteFinding).not.toHaveBeenCalled();
    expect(mockQueueAdd).not.toHaveBeenCalled();
  });

  it("uses local model pricing when detector inference reports zero cost", async () => {
    mockFetches(60_000, '{"span":1}\n');
    mockPrisma.detector.findMany.mockResolvedValue([
      {
        id: "d1",
        name: "Slow",
        prompt: "p",
        outputSchema: [],
        detectionModel: "glm-5.2",
        detectionProvider: "zai",
        detectionSource: "byok",
        enableRca: false,
      },
    ]);
    mockRunDetection.mockResolvedValue({
      identified: false,
      summary: "clean",
      data: {},
      inferenceCost: 0,
      inferenceInputTokens: 1000,
      inferenceOutputTokens: 500,
      inferenceSource: "byok",
      inferenceModel: "glm-5.2",
      inferenceProvider: "zai",
    });
    mockCalculateCost.mockResolvedValue(0.0015);

    await processTrace("t1", "p1", ["d1"]);

    expect(mockCalculateCost).toHaveBeenCalledWith("glm-5.2", 1000, 500);
    expect(mockPrisma.aIMessage.createMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({
          model: "glm-5.2",
          provider: "zai",
          isByok: true,
          inputTokens: 1000,
          outputTokens: 500,
          cost: 0.0015,
        }),
      ],
    });
  });

  it("does not write detector AI usage when inference has no model attribution", async () => {
    mockFetches(60_000, '{"span":1}\n');
    mockPrisma.detector.findMany.mockResolvedValue([
      {
        id: "d1",
        name: "Slow",
        prompt: "p",
        outputSchema: [],
        detectionModel: null,
        detectionProvider: null,
        detectionSource: "system",
        enableRca: false,
      },
    ]);
    mockRunDetection.mockResolvedValue({
      identified: false,
      summary: "Analysis failed",
      data: {},
      error: 'No API key configured for provider "anthropic"',
      inferenceCost: 0,
      inferenceInputTokens: 0,
      inferenceOutputTokens: 0,
      inferenceSource: "system",
      inferenceModel: null,
      inferenceProvider: null,
    });

    await processTrace("t1", "p1", ["d1"]);

    expect(mockPrisma.aIMessage.createMany).not.toHaveBeenCalled();
  });
});

describe("processTrace — self-trace emission", () => {
  const DETECTOR = {
    id: "d1",
    name: "Slow",
    prompt: "p",
    outputSchema: [],
    detectionModel: null,
    detectionProvider: null,
    detectionSource: "system",
    enableRca: false,
  };
  const CLEAN_RESULT = {
    identified: false,
    summary: "clean",
    data: {},
    inferenceCost: 0,
    inferenceInputTokens: 10,
    inferenceOutputTokens: 2,
    inferenceSource: "system",
    inferenceModel: "m",
    inferenceProvider: "anthropic",
  };

  beforeEach(() => {
    mockFetches(60_000, '{"span":1}\n');
    mockPrisma.detector.findMany.mockResolvedValue([DETECTOR]);
  });

  it("wraps the eval in a self-trace and stamps selfTraced on a not-triggered run write", async () => {
    mockRunDetection.mockResolvedValue(CLEAN_RESULT);

    await processTrace("t1", "p1", ["d1"]);

    expect(mockWithSelfTrace).toHaveBeenCalledTimes(1);
    const meta = mockWithSelfTrace.mock.calls[0][0];
    expect(meta.projectId).toBe("p1");
    expect(meta.scannedTraceId).toBe("t1");
    expect(meta.detectorId).toBe("d1");
    expect(meta.detectorName).toBe("Slow");
    // Dashless 32-hex — the same shape as a trace id, and the self-trace's
    // trace_id verbatim.
    expect(meta.runId).toMatch(/^[0-9a-f]{32}$/);
    // The eval genuinely ran inside the wrapper.
    expect(mockRunDetection).toHaveBeenCalledTimes(1);
    expect(mockWriteRun).toHaveBeenCalledWith(expect.objectContaining({ selfTraced: true }));
  });

  it("stamps the failed run write when the eval throws inside the wrapper", async () => {
    mockRunDetection.mockRejectedValue(new Error("boom"));

    await processTrace("t1", "p1", ["d1"]);

    expect(mockWithSelfTrace).toHaveBeenCalledTimes(1);
    expect(mockWriteRun).toHaveBeenCalledWith(
      expect.objectContaining({ status: "failed", selfTraced: true }),
    );
  });

  it("carries selfTraced onto the triggered run write", async () => {
    mockRunDetection.mockResolvedValue({ ...CLEAN_RESULT, identified: true, summary: "found" });

    await processTrace("t1", "p1", ["d1"]);

    const runWrites = mockWriteRun.mock.calls.map((c) => c[0]);
    const triggeredWrite = runWrites.find((w) => w.findingId !== null);
    expect(triggeredWrite?.selfTraced).toBe(true);
  });

  it("records selfTraced false when tracing declines but the eval still runs", async () => {
    mockWithSelfTrace.mockImplementation(async (_meta: unknown, fn: () => Promise<unknown>) => ({
      ok: true,
      value: await fn(),
      selfTraced: false,
    }));
    mockRunDetection.mockResolvedValue(CLEAN_RESULT);

    await processTrace("t1", "p1", ["d1"]);

    expect(mockRunDetection).toHaveBeenCalledTimes(1);
    expect(mockWriteRun).toHaveBeenCalledWith(expect.objectContaining({ selfTraced: false }));
  });

  it("does not start a self-trace when the spans download fails before any run", async () => {
    mockFetch.mockImplementation((url: string) => {
      if (String(url).includes("/time-since-last-span")) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ time_since_last_span_ms: 60_000 }),
        });
      }
      return Promise.resolve({ ok: false, status: 500 });
    });

    await processTrace("t1", "p1", ["d1"]);

    expect(mockWithSelfTrace).not.toHaveBeenCalled();
    expect(mockWriteRun).toHaveBeenCalledWith(
      expect.not.objectContaining({ selfTraced: expect.anything() }),
    );
  });
});
