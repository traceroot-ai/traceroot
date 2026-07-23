import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { mockInitialize, mockObserve, mockFlush, mockShutdown } = vi.hoisted(() => ({
  mockInitialize: vi.fn(),
  mockObserve: vi.fn(),
  mockFlush: vi.fn(),
  mockShutdown: vi.fn(),
}));
vi.mock("@traceroot-ai/traceroot", () => ({
  TraceRoot: { initialize: mockInitialize, flush: mockFlush, shutdown: mockShutdown },
  observe: mockObserve,
}));

import { SpanStatusCode, trace } from "@opentelemetry/api";
import {
  withSelfTrace,
  currentSelfTraceScope,
  shutdownSelfTraceEmitter,
  type SelfTraceRunMeta,
} from "../self-trace-emitter.js";

function meta(over: Partial<SelfTraceRunMeta> = {}): SelfTraceRunMeta {
  return {
    runId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    projectId: "proj-1",
    detectorId: "det-1",
    detectorName: "Latency spike",
    scannedTraceId: "trace-1",
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockFlush.mockResolvedValue(undefined);
  mockShutdown.mockResolvedValue(undefined);
  // Faithful stand-in for the SDK: observe runs the callback and rethrows.
  mockObserve.mockImplementation(async (_opts: unknown, fn: () => Promise<unknown>) => fn());
});

afterEach(async () => {
  // Reset the module's initialized flag between tests.
  await shutdownSelfTraceEmitter();
  vi.unstubAllEnvs();
});

describe("without a secret", () => {
  it("runs fn and declines to trace", async () => {
    vi.stubEnv("INTERNAL_API_SECRET", "");
    const run = await withSelfTrace(meta(), async () => "verdict");
    expect(run).toEqual({ ok: true, value: "verdict", selfTraced: false });
    expect(mockInitialize).not.toHaveBeenCalled();
    expect(mockObserve).not.toHaveBeenCalled();
  });

  it("propagates fn failures as ok:false without tracing", async () => {
    vi.stubEnv("INTERNAL_API_SECRET", "");
    const run = await withSelfTrace(meta(), async () => {
      throw new Error("boom");
    });
    expect(run.ok).toBe(false);
    expect(run.selfTraced).toBe(false);
    if (!run.ok) expect((run.error as Error).message).toBe("boom");
  });
});

describe("with a secret (SDK-traced path)", () => {
  beforeEach(() => {
    vi.stubEnv("INTERNAL_API_SECRET", "test-secret");
  });

  it("initializes the SDK in internal-export mode without a default project", async () => {
    await withSelfTrace(meta(), async () => 1);
    expect(mockInitialize).toHaveBeenCalledTimes(1);
    const opts = mockInitialize.mock.calls[0][0];
    expect(opts.internalExport.path).toBe("/api/v1/internal/traces");
    expect(opts.internalExport.headers["X-Internal-Secret"]).toBe("test-secret");
    // Per-root attribution is primary — no process-default projectId.
    expect(opts.internalExport.projectId).toBeUndefined();
    expect(opts.globalAttributes["traceroot.source"]).toBe("detector");
  });

  it("observes the run with the forced dashless run id and its project", async () => {
    const run = await withSelfTrace(meta(), async () => 42);
    expect(run).toEqual({ ok: true, value: 42, selfTraced: true });
    const opts = mockObserve.mock.calls[0][0];
    expect(opts.name).toBe("detector-run: Latency spike");
    expect(opts.traceId).toBe("aaaaaaaabbbbccccddddeeeeeeeeeeee");
    expect(opts.projectId).toBe("proj-1");
    expect(opts.metadata).toEqual({
      detectorId: "det-1",
      detectorName: "Latency spike",
      scannedTraceId: "trace-1",
    });
    // recordIo owns the root output; the SDK default capture is unbounded.
    expect(opts.captureOutput).toBe(false);
  });

  it("exposes the scope to code running inside fn, and clears it outside", async () => {
    expect(currentSelfTraceScope()).toBeUndefined();
    await withSelfTrace(meta(), async () => {
      expect(currentSelfTraceScope()).toEqual({
        traceId: "aaaaaaaabbbbccccddddeeeeeeeeeeee",
        projectId: "proj-1",
      });
      return null;
    });
    expect(currentSelfTraceScope()).toBeUndefined();
  });

  it("maps fn throws to ok:false while still selfTraced", async () => {
    const run = await withSelfTrace(meta(), async () => {
      throw new Error("eval exploded");
    });
    expect(run.ok).toBe(false);
    expect(run.selfTraced).toBe(true);
    if (!run.ok) expect((run.error as Error).message).toBe("eval exploded");
  });

  it("invokes recordIo with fn's result on success only", async () => {
    const recordIo = vi.fn().mockReturnValue({ input: "in", output: "out" });
    await withSelfTrace(meta(), async () => ({ verdict: "clean" }), { recordIo });
    expect(recordIo).toHaveBeenCalledWith({ verdict: "clean" });

    recordIo.mockClear();
    await withSelfTrace(
      meta(),
      async () => {
        throw new Error("no");
      },
      { recordIo },
    );
    expect(recordIo).not.toHaveBeenCalled();
  });

  it("still runs fn exactly once when observe fails before reaching it", async () => {
    mockObserve.mockImplementation(() => {
      throw new Error("sdk broken");
    });
    let calls = 0;
    const run = await withSelfTrace(meta(), async () => {
      calls += 1;
      return "survived";
    });
    expect(calls).toBe(1);
    expect(run).toEqual({ ok: true, value: "survived", selfTraced: false });
  });

  it("marks the root errored when recordIo reports an eval failure result", async () => {
    const fakeSpan = { setAttribute: vi.fn(), setStatus: vi.fn() };
    const spy = vi.spyOn(trace, "getActiveSpan").mockReturnValue(fakeSpan as never);
    try {
      await withSelfTrace(meta(), async () => ({}), {
        recordIo: () => ({ input: "in", output: "out", error: "provider down" }),
      });
      expect(fakeSpan.setAttribute).toHaveBeenCalledWith("traceroot.span.input", "in");
      expect(fakeSpan.setAttribute).toHaveBeenCalledWith("traceroot.span.output", "out");
      expect(fakeSpan.setStatus).toHaveBeenCalledWith({
        code: SpanStatusCode.ERROR,
        message: "provider down",
      });
    } finally {
      spy.mockRestore();
    }
  });

  it("leaves the root status untouched when recordIo reports no error", async () => {
    const fakeSpan = { setAttribute: vi.fn(), setStatus: vi.fn() };
    const spy = vi.spyOn(trace, "getActiveSpan").mockReturnValue(fakeSpan as never);
    try {
      await withSelfTrace(meta(), async () => ({}), {
        recordIo: () => ({ input: "in", output: "out" }),
      });
      expect(fakeSpan.setStatus).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it("returns fn's success when observe fails after fn completed", async () => {
    // e.g. the SDK throws while ending the root span — the evaluation itself
    // finished, so the run must stay ok:true and only lose its tracing.
    mockObserve.mockImplementation(async (_opts: unknown, fn: () => Promise<unknown>) => {
      await fn();
      throw new Error("span.end exploded");
    });
    let calls = 0;
    const run = await withSelfTrace(meta(), async () => {
      calls += 1;
      return "verdict";
    });
    expect(calls).toBe(1);
    expect(run).toEqual({ ok: true, value: "verdict", selfTraced: false });
  });

  it("still runs fn once when the meta is unusable (never throws into the run)", async () => {
    const bad = meta();
    (bad as { runId: unknown }).runId = undefined;
    let calls = 0;
    const run = await withSelfTrace(bad, async () => {
      calls += 1;
      return "survived";
    });
    expect(calls).toBe(1);
    expect(run.ok).toBe(true);
    expect(run.selfTraced).toBe(false);
  });

  it("shutdown flushes then shuts down, never rejects, safe to call twice", async () => {
    await withSelfTrace(meta(), async () => "x");
    mockFlush.mockRejectedValue(new Error("export failed"));
    await expect(shutdownSelfTraceEmitter()).resolves.toBeUndefined();
    expect(mockFlush).toHaveBeenCalledTimes(1);
    expect(mockShutdown).toHaveBeenCalledTimes(1);
    await expect(shutdownSelfTraceEmitter()).resolves.toBeUndefined();
    expect(mockShutdown).toHaveBeenCalledTimes(1);
  });
});
