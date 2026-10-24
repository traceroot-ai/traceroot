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
  mockEnqueueSignalHits,
} = vi.hoisted(() => ({
  mockEnqueueSignalHits: vi.fn(),
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
vi.mock("../../ee/signals/queue.js", () => ({ enqueueSignalHits: mockEnqueueSignalHits }));
const { mockScheduleFindingDigest } = vi.hoisted(() => ({ mockScheduleFindingDigest: vi.fn() }));
vi.mock("../../notifications/digest-schedule.js", () => ({
  scheduleFindingDigest: mockScheduleFindingDigest,
}));

// The processor reads INTERNAL_API_SECRET once, at import time, so the stub has
// to be in place before the module is loaded. A known value lets the test assert
// the exact credential the worker sends, instead of accepting the empty
// fallback the production code falls back to when the secret is unset.
vi.hoisted(() => {
  process.env.INTERNAL_API_SECRET = "test-internal-secret";
});

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

import { DelayedError } from "bullmq";
import { handleDetectorRunJob, processTrace } from "../detector-run-processor.js";

const BASE_JOB: DetectorRunJob = { traceId: "t1", detectorIds: ["d1"], projectId: "p1" };

/** Make the time-since-last-span fetch report `ms` of quiet; spans-jsonl returns `spans`. */
function mockFetches(ms: number, spans = "", eligibleDetectorIds = ["d1"]) {
  mockFetch.mockImplementation((url: string) => {
    if (String(url).includes("/time-since-last-span")) {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ time_since_last_span_ms: ms }),
      });
    }
    if (String(url).includes("/eligible-detectors")) {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ detector_ids: eligibleDetectorIds }),
      });
    }
    return Promise.resolve({ ok: true, text: () => Promise.resolve(spans) });
  });
}

/** The request kinds, in the order they were made — proves the eligibility lookup
 * happens between the two quietness checks and before any span download. */
function fetchSequence(): string[] {
  return mockFetch.mock.calls.map(([url]) => {
    const value = String(url);
    if (value.includes("/time-since-last-span")) return "quiet";
    if (value.includes("/eligible-detectors")) return "eligible";
    if (value.includes("/spans-jsonl")) return "spans";
    return "other";
  });
}

/** The eligibility request's URL and headers, for asserting the exact payload. */
function eligibleRequest() {
  const call = mockFetch.mock.calls.find(([url]) => String(url).includes("/eligible-detectors"));
  return call ? { url: String(call[0]), init: call[1] as RequestInit | undefined } : undefined;
}

function makeJob(over: Partial<Job<DetectorRunJob>> = {}): Job<DetectorRunJob> {
  return { data: BASE_JOB, moveToDelayed: vi.fn(), ...over } as unknown as Job<DetectorRunJob>;
}

type RecordedIo = { input?: string; output?: string; error?: string };
let lastRecordedIo: RecordedIo | undefined;

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
  mockEnqueueSignalHits.mockResolvedValue(0);
  mockScheduleFindingDigest.mockResolvedValue(undefined);
  // Default: tracing works — run fn once, report selfTraced, surface throws
  // as ok:false (mirrors the real withSelfTrace contract).
  lastRecordedIo = undefined;
  // Faithful stand-in: the real withSelfTrace invokes options.recordIo with fn's
  // result to fill the root span's boundary I/O. Dropping the third argument here
  // meant the processor's recordIo body was never executed by any test.
  mockWithSelfTrace.mockImplementation(
    async (
      _meta: unknown,
      fn: () => Promise<unknown>,
      options?: { recordIo?: (v: unknown) => RecordedIo },
    ) => {
      try {
        const value = await fn();
        lastRecordedIo = options?.recordIo?.(value);
        return { ok: true, value, selfTraced: true };
      } catch (error) {
        return { ok: false, error, selfTraced: true };
      }
    },
  );
});

describe("handleDetectorRunJob — quiescence gate", () => {
  it("evaluates a quiet trace: quiet-check → eligibility → quiet-check → spans", async () => {
    mockFetches(60_000); // quiet 60s == EVALUATOR_DELAY
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
    const job = makeJob();
    await handleDetectorRunJob(job);

    expect(fetchSequence()).toEqual(["quiet", "eligible", "quiet", "spans"]);
    expect(job.moveToDelayed).not.toHaveBeenCalled();
    expect(mockRunDetection).toHaveBeenCalledTimes(1);
  });

  it("queries eligibility after the initial quietness check with the candidate ids", async () => {
    mockFetches(60_000);
    const job = makeJob();
    await handleDetectorRunJob(job);

    const request = eligibleRequest();
    expect(request).toBeDefined();
    expect(request!.url).toContain("/api/v1/internal/traces/t1/eligible-detectors");
    expect(request!.url).toContain("project_id=p1");
    expect(request!.url).toContain("detector_ids=d1");
    expect(request!.init?.headers).toEqual({
      "X-Internal-Secret": "test-internal-secret",
    });
    // The eligibility lookup is the only thing between the two quiet checks.
    expect(fetchSequence()).toEqual(["quiet", "eligible", "quiet", "spans"]);
  });

  it("does not download spans or run the model when no candidate is eligible", async () => {
    mockFetches(60_000, "", []);
    await handleDetectorRunJob(makeJob());

    expect(fetchSequence()).toEqual(["quiet", "eligible", "quiet"]);
    expect(mockFetch).not.toHaveBeenCalledWith(
      expect.stringContaining("/spans-jsonl"),
      expect.anything(),
    );
    expect(mockRunDetection).not.toHaveBeenCalled();
    expect(mockPrisma.detector.findMany).not.toHaveBeenCalled();
  });

  it("does not query eligibility while the trace is still noisy", async () => {
    mockFetches(21_000); // quiet 21s → re-check in 39s
    const job = makeJob();
    await expect(handleDetectorRunJob(job, "tok")).rejects.toBeInstanceOf(DelayedError);

    expect(fetchSequence()).toEqual(["quiet"]);
    expect(mockFetch).not.toHaveBeenCalledWith(
      expect.stringContaining("/eligible-detectors"),
      expect.anything(),
    );
    expect(mockFetch).not.toHaveBeenCalledWith(
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
  });

  it("re-delays when new spans arrive during the eligibility lookup", async () => {
    // First quiet check passes; the post-eligibility check does not.
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ time_since_last_span_ms: 60_000 }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ detector_ids: ["d1"] }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ time_since_last_span_ms: 5_000 }),
      });
    const job = makeJob();
    await expect(handleDetectorRunJob(job, "tok")).rejects.toBeInstanceOf(DelayedError);

    expect(fetchSequence()).toEqual(["quiet", "eligible", "quiet"]);
    expect(job.moveToDelayed).toHaveBeenCalledTimes(1);
    expect(mockRunDetection).not.toHaveBeenCalled();
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

  it("throws (for BullMQ retry) when the eligibility fetch fails", async () => {
    mockFetch.mockImplementation((url: string) => {
      if (String(url).includes("/time-since-last-span")) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ time_since_last_span_ms: 60_000 }),
        });
      }
      return Promise.resolve({ ok: false, status: 503 });
    });
    const job = makeJob();
    await expect(handleDetectorRunJob(job)).rejects.toThrow();

    // Eligibility was queried (after the quiet check) but its failure surfaces as
    // a retryable throw, not a silent skip.
    expect(fetchSequence()).toEqual(["quiet", "eligible"]);
    expect(job.moveToDelayed).not.toHaveBeenCalled();
  });

  it("throws (for BullMQ retry) when the eligibility response is malformed", async () => {
    mockFetch.mockImplementation((url: string) => {
      if (String(url).includes("/time-since-last-span")) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ time_since_last_span_ms: 60_000 }),
        });
      }
      if (String(url).includes("/eligible-detectors")) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ detector_ids: "not-an-array" }),
        });
      }
      return Promise.resolve({ ok: true, text: () => Promise.resolve("") });
    });
    await expect(handleDetectorRunJob(makeJob())).rejects.toThrow();
    expect(mockRunDetection).not.toHaveBeenCalled();
  });

  it("passes only the eligible detector ids to processing", async () => {
    mockFetches(60_000, '{"span":1}\n', ["d2"]);
    mockPrisma.detector.findMany.mockResolvedValue([
      {
        id: "d2",
        name: "Only",
        prompt: "p",
        outputSchema: [],
        detectionModel: null,
        detectionProvider: null,
        detectionSource: "system",
        enableRca: false,
      },
    ]);
    const job = makeJob({ data: { ...BASE_JOB, detectorIds: ["d1", "d2"] } });
    await handleDetectorRunJob(job);

    expect(fetchSequence()).toEqual(["quiet", "eligible", "quiet", "spans"]);
    expect(mockPrisma.detector.findMany).toHaveBeenCalledWith({
      where: { id: { in: ["d2"] }, enabled: true },
    });
    expect(mockRunDetection).toHaveBeenCalledTimes(1);
  });

  it("deduplicates duplicate candidate ids before processing", async () => {
    mockFetches(60_000, '{"span":1}\n', ["d1"]);
    mockPrisma.detector.findMany.mockResolvedValue([
      {
        id: "d1",
        name: "Only",
        prompt: "p",
        outputSchema: [],
        detectionModel: null,
        detectionProvider: null,
        detectionSource: "system",
        enableRca: false,
      },
    ]);
    const job = makeJob({ data: { ...BASE_JOB, detectorIds: ["d1", "d1"] } });
    await handleDetectorRunJob(job);

    expect(mockPrisma.detector.findMany).toHaveBeenCalledWith({
      where: { id: { in: ["d1"] }, enabled: true },
    });
    expect(mockRunDetection).toHaveBeenCalledTimes(1);
  });
});

describe("processTrace — finding + RCA", () => {
  it("writes a finding and its runs with one capture time, and starts no RCA itself", async () => {
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
        enableSignals: false,
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
    // RCA follows signals: the assignment job starts it when a hit opens a
    // signal. Detection itself neither seeds an RCA row nor enqueues a job.
    expect(mockPrisma.detectorRca.upsert).not.toHaveBeenCalled();
    expect(mockQueueAdd).not.toHaveBeenCalled();

    // The finding row and its triggered run carry the SAME capture time.
    const ts = mockWriteFinding.mock.calls[0][0].timestampMs;
    expect(typeof ts).toBe("number");
    expect(mockWriteRun.mock.calls[0][0].timestampMs).toBe(ts);
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
    expect(meta.name).toBe("detector-run: Slow");
    expect(meta.metadata).toEqual({ detectorId: "d1", detectorName: "Slow", scannedTraceId: "t1" });
    // Dashless 32-hex — the run id verbatim, forced as the self-trace's trace_id.
    expect(meta.traceId).toMatch(/^[0-9a-f]{32}$/);
    // The eval genuinely ran inside the wrapper.
    expect(mockRunDetection).toHaveBeenCalledTimes(1);
    expect(mockWriteRun).toHaveBeenCalledWith(expect.objectContaining({ selfTraced: true }));
  });

  it("supplies the self-trace root's boundary I/O, and the eval error when one is reported", async () => {
    // recordIo fills the root span's input/output — which the transform promotes to the
    // trace record, so it is what the trace header shows — and marks the root ERROR for
    // an eval that resolved with a failure rather than throwing.
    mockRunDetection.mockResolvedValue({ ...CLEAN_RESULT, error: "provider down" });

    await processTrace("t1", "p1", ["d1"]);

    expect(lastRecordedIo).toBeDefined();
    expect(typeof lastRecordedIo?.input).toBe("string");
    expect(lastRecordedIo?.input).toContain("Slow");
    expect(typeof lastRecordedIo?.output).toBe("string");
    expect(lastRecordedIo?.error).toBe("provider down");
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

describe("processTrace — usage-meter classification", () => {
  const DETECTOR = {
    id: "d1",
    name: "Slow",
    prompt: "p",
    outputSchema: [],
    detectionModel: "m",
    detectionProvider: "anthropic",
    detectionSource: "system",
    enableRca: false,
  };
  const BASE_RESULT = {
    identified: false,
    summary: "clean",
    data: {},
    inferenceCost: 0,
    inferenceInputTokens: 0,
    inferenceOutputTokens: 0,
    inferenceSource: "system",
    inferenceModel: "m",
    inferenceProvider: "anthropic",
  };

  beforeEach(() => {
    mockFetches(60_000, '{"span":1}\n');
    mockPrisma.detector.findMany.mockResolvedValue([DETECTOR]);
  });

  it("marks a failed run that recorded tokens as inference-using", async () => {
    // The eval reached the model, burned calls, then failed (e.g. no
    // submit_result). The scan consumed quota even though it failed.
    mockRunDetection.mockResolvedValue({
      ...BASE_RESULT,
      summary: "Analysis failed",
      error: "No submit_result tool call",
      inferenceInputTokens: 900,
      inferenceOutputTokens: 120,
    });

    await processTrace("t1", "p1", ["d1"]);

    expect(mockWriteRun).toHaveBeenCalledWith(
      expect.objectContaining({ status: "failed", usedInference: true }),
    );
  });

  it("marks a clean run that recorded tokens as inference-using", async () => {
    mockRunDetection.mockResolvedValue({
      ...BASE_RESULT,
      inferenceInputTokens: 500,
      inferenceOutputTokens: 40,
    });

    await processTrace("t1", "p1", ["d1"]);

    expect(mockWriteRun).toHaveBeenCalledWith(
      expect.objectContaining({ status: "completed", usedInference: true }),
    );
  });

  it("leaves a pre-model failure out of the meter even when it names a provider", async () => {
    // Missing API key / unknown model: an error that names a provider or model
    // without tokens is not a billed call.
    mockRunDetection.mockResolvedValue({
      ...BASE_RESULT,
      summary: "Analysis failed",
      error: 'No API key configured for provider "anthropic"',
      inferenceModel: null,
      inferenceProvider: null,
    });

    await processTrace("t1", "p1", ["d1"]);

    expect(mockWriteRun).toHaveBeenCalledWith(
      expect.objectContaining({ status: "failed", usedInference: false }),
    );
  });

  it("does not infer usage from a positive cost without tokens", async () => {
    // Token counts are the evidence a model was reached; cost alone is not.
    mockRunDetection.mockResolvedValue({
      ...BASE_RESULT,
      summary: "Analysis failed",
      error: "provider overloaded",
      inferenceCost: 0.01,
    });

    await processTrace("t1", "p1", ["d1"]);

    expect(mockWriteRun).toHaveBeenCalledWith(
      expect.objectContaining({ status: "failed", usedInference: false }),
    );
  });

  it("leaves a thrown eval out of the meter", async () => {
    mockRunDetection.mockRejectedValue(new Error("boom"));

    await processTrace("t1", "p1", ["d1"]);

    expect(mockWriteRun).toHaveBeenCalledWith(
      expect.objectContaining({ status: "failed", usedInference: false }),
    );
  });

  it("leaves a spans-download failure out of the meter", async () => {
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

    expect(mockWriteRun).toHaveBeenCalledWith(
      expect.objectContaining({ status: "failed", usedInference: false }),
    );
  });

  it("carries usage onto the triggered run write", async () => {
    mockRunDetection.mockResolvedValue({
      ...BASE_RESULT,
      identified: true,
      summary: "found it",
      inferenceInputTokens: 700,
      inferenceOutputTokens: 60,
    });

    await processTrace("t1", "p1", ["d1"]);

    const triggeredWrite = mockWriteRun.mock.calls
      .map((c) => c[0])
      .find((w) => w.findingId !== null);
    expect(triggeredWrite?.usedInference).toBe(true);
  });
});

describe("processTrace — signals call site", () => {
  const spans = JSON.stringify({ span_id: "s", span_start_time: "2026-09-30T09:00:00" });

  function triggerOne() {
    mockPrisma.detector.findMany.mockResolvedValue([
      {
        id: "d1",
        name: "Failure",
        prompt: "p",
        outputSchema: [],
        enableRca: true,
        enableSignals: true,
        template: "failure",
      },
    ]);
    mockRunDetection.mockResolvedValue({
      identified: true,
      summary: "tool timed out",
      data: { tool: "search" },
      inferenceCost: 0,
      inferenceInputTokens: 0,
      inferenceOutputTokens: 0,
      inferenceSource: "system",
      inferenceModel: null,
      inferenceProvider: "anthropic",
    });
  }

  it("enqueues assignment for the finding's triggered detectors after the finding is written", async () => {
    mockFetches(60_000, spans);
    triggerOne();
    await processTrace("t1", "p1", ["d1"]);
    expect(mockEnqueueSignalHits).toHaveBeenCalledOnce();
    const args = mockEnqueueSignalHits.mock.calls[0][0];
    expect(args.projectId).toBe("p1");
    expect(args.detectors[0]).toMatchObject({ id: "d1", enableSignals: true });
    expect(args.triggered.map((t: { detectorId: string }) => t.detectorId)).toEqual(["d1"]);
    // The job reads hits back from ClickHouse, so they must be written first.
    const enqueueOrder = mockEnqueueSignalHits.mock.invocationCallOrder[0];
    const lastRunWrite = Math.max(...mockWriteRun.mock.invocationCallOrder);
    expect(enqueueOrder).toBeGreaterThan(lastRunWrite);
    expect(enqueueOrder).toBeGreaterThan(mockWriteFinding.mock.invocationCallOrder[0]);
  });

  it("keeps the finding when enqueueing for signals fails", async () => {
    mockFetches(60_000, spans);
    triggerOne();
    mockEnqueueSignalHits.mockRejectedValueOnce(new Error("pg down"));
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(processTrace("t1", "p1", ["d1"])).resolves.toBeUndefined();
    expect(mockWriteFinding).toHaveBeenCalledOnce();
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining("Failed to enqueue signal assignment"),
      expect.any(Error),
    );
    error.mockRestore();
  });

  it("does not queue anything when a detector with signals on evaluates clean", async () => {
    mockFetches(60_000, spans);
    triggerOne();
    mockRunDetection.mockResolvedValue({
      identified: false,
      summary: "clean",
      data: {},
      inferenceCost: 0,
      inferenceInputTokens: 0,
      inferenceOutputTokens: 0,
      inferenceSource: "system",
      inferenceModel: null,
      inferenceProvider: "anthropic",
    });
    await processTrace("t1", "p1", ["d1"]);
    expect(mockRunDetection).toHaveBeenCalledOnce();
    expect(mockEnqueueSignalHits).not.toHaveBeenCalled();
  });
});

describe("processTrace — notifications", () => {
  const spans = JSON.stringify({ span_id: "s", span_start_time: "2026-09-30T09:00:00" });
  function trigger(enableSignals: boolean) {
    mockPrisma.detector.findMany.mockResolvedValue([
      { id: "d1", name: "Failure", prompt: "p", outputSchema: [], enableRca: true, enableSignals },
    ]);
    mockRunDetection.mockResolvedValue({
      identified: true,
      summary: "tool timed out",
      data: {},
      inferenceCost: 0,
      inferenceInputTokens: 0,
      inferenceOutputTokens: 0,
      inferenceSource: "system",
      inferenceModel: null,
      inferenceProvider: "anthropic",
    });
    mockPrisma.project.findUnique.mockResolvedValue({
      workspaceId: "w1",
      workspace: { billingPlan: "pro", detectorBlocked: false },
    });
  }

  // Only the signal digest notifies, for new and reopened signals: a finding
  // never schedules a per-finding notification, whatever its detector does.
  it.each([
    ["grouping into signals", true, "sk"],
    ["not grouping into signals", false, "sk"],
    ["in a deployment without the signals key", true, ""],
  ])("schedules no per-finding notification for a detector %s", async (_, enableSignals, key) => {
    vi.stubEnv("OPENAI_API_KEY", key);
    mockFetches(60_000, spans);
    trigger(enableSignals);
    await processTrace("t1", "p1", ["d1"]);
    expect(mockWriteFinding).toHaveBeenCalled();
    expect(mockScheduleFindingDigest).not.toHaveBeenCalled();
    vi.unstubAllEnvs();
  });
});
