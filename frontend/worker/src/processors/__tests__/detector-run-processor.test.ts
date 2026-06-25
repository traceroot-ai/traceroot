import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Job } from "bullmq";
import type { DetectorRunJob } from "../../queues/detector-run-queue.js";

const EVALUATOR_DELAY = 60_000;

const { mockRunDetection, mockWriteRun, mockWriteFinding, mockQueueAdd, mockPrisma } = vi.hoisted(
  () => ({
    mockRunDetection: vi.fn(),
    mockWriteRun: vi.fn(),
    mockWriteFinding: vi.fn(),
    mockQueueAdd: vi.fn(),
    mockPrisma: {
      detector: { findMany: vi.fn() },
      project: { findUnique: vi.fn() },
      aIMessage: { createMany: vi.fn() },
      detectorRca: { upsert: vi.fn() },
    },
  }),
);

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
  EVALUATOR_DELAY: 60_000,
  createRedisConnection: () => ({}),
}));

vi.mock("../../detection/sandbox-eval.js", () => ({ runDetectionForTrace: mockRunDetection }));
vi.mock("../../detection/clickhouse-writer.js", () => ({
  writeDetectorRun: mockWriteRun,
  writeDetectorFinding: mockWriteFinding,
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
  mockPrisma.aIMessage.createMany.mockResolvedValue(undefined);
  mockPrisma.detectorRca.upsert.mockResolvedValue(undefined);
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
  it("skips LLM evaluation if filterSpanName is set but no matching spans exist", async () => {
    // Trace has a span named "other-span", but detector wants "target-span"
    mockFetches(60_000, '{"name": "other-span", "span":1}\n');
    mockPrisma.detector.findMany.mockResolvedValue([
      {
        id: "d1",
        name: "Filtered",
        prompt: "p",
        outputSchema: [],
        detectionModel: null,
        detectionProvider: null,
        detectionSource: "system",
        enableRca: false,
        filterSpanName: "target-span",
      },
    ]);
    const job = makeJob();
    await handleDetectorRunJob(job);
    
    // The run detection logic should be completely skipped!
    expect(mockRunDetection).not.toHaveBeenCalled();
    // But it SHOULD log the run as completed to DB
    expect(mockWriteRun).toHaveBeenCalledWith(
      expect.objectContaining({ status: "completed", findingId: null })
    );
  });

  it("filters spans and passes only matches to LLM if filterSpanName is set", async () => {
    // Trace has a mix of spans
    mockFetches(60_000, '{"name": "other-span", "span":1}\n{"name": "target-span", "span":2}\n');
    mockPrisma.detector.findMany.mockResolvedValue([
      {
        id: "d1",
        name: "Filtered",
        prompt: "p",
        outputSchema: [],
        detectionModel: null,
        detectionProvider: null,
        detectionSource: "system",
        enableRca: false,
        filterSpanName: "target-span",
      },
    ]);
    mockRunDetection.mockResolvedValue({
      identified: false,
      summary: "",
      data: {},
      inferenceCost: 0,
      inferenceInputTokens: 0,
      inferenceOutputTokens: 0,
      inferenceSource: "system",
      inferenceModel: "m",
      inferenceProvider: "p",
    });

    const job = makeJob();
    await handleDetectorRunJob(job);
    
    // The LLM SHOULD be called, but only with the matching span
    expect(mockRunDetection).toHaveBeenCalledWith(
      expect.objectContaining({ spansJsonl: '{"name":"target-span","span":2}' })
    );
    expect(mockWriteRun).toHaveBeenCalledWith(
      expect.objectContaining({ status: "completed", findingId: null })
    );
  });

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
        filterSpanName: null,
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
});
