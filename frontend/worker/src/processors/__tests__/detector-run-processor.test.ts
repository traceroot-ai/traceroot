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

/** Make the settle-status fetch report `seconds` of quiet; spans-jsonl returns `spans`. */
function mockFetches(seconds: number, spans = "") {
  mockFetch.mockImplementation((url: string) => {
    if (String(url).includes("/settle-status")) {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ last_arrival_age_seconds: seconds }),
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
});

describe("handleDetectorRunJob — quiescence gate", () => {
  it("evaluates when the trace has been quiet >= EVALUATOR_DELAY", async () => {
    mockFetches(60); // 60s == 60_000ms
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
    mockFetches(21); // quiet 21s → re-check in 39s
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

  it("throws (for BullMQ retry) when settle-status fetch fails", async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 500 });
    await expect(handleDetectorRunJob(makeJob())).rejects.toThrow();
  });
});

describe("processTrace — finding + RCA", () => {
  it("writes a finding, runs, and an RCA job when a detector triggers", async () => {
    mockFetches(60, '{"span":1}\n');
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
  });

  it("writes no finding when nothing triggers", async () => {
    mockFetches(60, '{"span":1}\n');
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
