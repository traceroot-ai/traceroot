import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { mockInitialize, mockObserve, mockFlush, mockShutdown, mockIsTracingActive } = vi.hoisted(
  () => ({
    mockInitialize: vi.fn(),
    mockObserve: vi.fn(),
    mockFlush: vi.fn(),
    mockShutdown: vi.fn(),
    mockIsTracingActive: vi.fn(),
  }),
);
vi.mock("@traceroot-ai/traceroot", () => ({
  TraceRoot: {
    initialize: mockInitialize,
    flush: mockFlush,
    shutdown: mockShutdown,
    isTracingActive: mockIsTracingActive,
  },
  observe: mockObserve,
}));

import { SpanStatusCode, trace } from "@opentelemetry/api";
import {
  withSelfTrace,
  currentSelfTraceScope,
  shutdownSelfTraceEmitter,
  type SelfTraceMeta,
} from "../self-trace-emitter.js";

function meta(over: Partial<SelfTraceMeta> = {}): SelfTraceMeta {
  return {
    traceId: "aaaaaaaabbbbccccddddeeeeeeeeeeee",
    projectId: "proj-1",
    name: "detector-run: Latency spike",
    metadata: { detectorId: "det-1", detectorName: "Latency spike", scannedTraceId: "trace-1" },
    ...over,
  };
}

beforeEach(() => {
  // clearAllMocks resets calls but NOT implementations, so a test that makes one of
  // these throw would leak that into every test after it. Re-establish the happy
  // path explicitly rather than relying on the clear.
  vi.clearAllMocks();
  mockInitialize.mockImplementation(() => {});
  mockFlush.mockResolvedValue(undefined);
  mockShutdown.mockResolvedValue(undefined);
  // Faithful stand-in for the SDK: observe runs the callback and rethrows.
  mockObserve.mockImplementation(async (_opts: unknown, fn: () => Promise<unknown>) => fn());
  // ...and the SDK's provider won global registration, so forcing takes effect.
  mockIsTracingActive.mockReturnValue(true);
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
    // internalExport is also what makes trace-id forcing available: the SDK installs
    // its id generator only for an internal target. isTracingActive() reports
    // registration, not forcing, so this is the caller side of that coupling.
    // The route classifies; sending a marker would make our traffic look like a
    // tenant trying to label theirs internal.
    expect(opts.globalAttributes?.["traceroot.source"]).toBeUndefined();
  });

  it("hands the caller's trace id, name, metadata and project to observe verbatim", async () => {
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

  it("does not shape the meta for a non-detector caller either", async () => {
    // The digest hands over a random id and its own name/metadata; the emitter
    // must not derive or rewrite any of it.
    const digest = {
      traceId: "0123456789abcdef0123456789abcdef",
      projectId: "proj-2",
      name: "digest-summary",
      metadata: { kind: "digest", window_start: 1000, window_end: 2000 },
    };
    let seen: unknown;
    await withSelfTrace(digest, async () => {
      seen = currentSelfTraceScope()?.traceId;
      return null;
    });
    expect(seen).toBe("0123456789abcdef0123456789abcdef");
    const opts = mockObserve.mock.calls[0][0];
    expect(opts.traceId).toBe("0123456789abcdef0123456789abcdef");
    expect(opts.projectId).toBe("proj-2");
    expect(opts.name).toBe("digest-summary");
    expect(opts.metadata).toBe(digest.metadata);
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

  it("stamps the trace-level metadata on the root before fn runs, so ingest promotes it", async () => {
    // observe() only sets the span-level metadata; the trace record's
    // metadata (what the viewer reads) comes from traceroot.trace.metadata.
    const fakeSpan = { setAttribute: vi.fn(), setStatus: vi.fn() };
    const spy = vi.spyOn(trace, "getActiveSpan").mockReturnValue(fakeSpan as never);
    try {
      const run = await withSelfTrace(meta(), async () => {
        // Already there when fn starts: a failed run keeps it.
        expect(fakeSpan.setAttribute).toHaveBeenCalledWith(
          "traceroot.trace.metadata",
          JSON.stringify(meta().metadata),
        );
        throw new Error("judge failed");
      });
      expect(run.ok).toBe(false);
    } finally {
      spy.mockRestore();
    }
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

describe("tracing-active guard", () => {
  // The guard latches its verdict for the process, so each case that disables
  // self-tracing needs a fresh copy of the module.
  async function freshEmitter() {
    vi.resetModules();
    return await import("../self-trace-emitter.js");
  }

  beforeEach(() => {
    vi.stubEnv("INTERNAL_API_SECRET", "test-secret");
  });

  it("emits normally while tracing is active", async () => {
    const run = await withSelfTrace(meta(), async () => "verdict");
    expect(run).toEqual({ ok: true, value: "verdict", selfTraced: true });
    expect(mockIsTracingActive).toHaveBeenCalled();
  });

  it("disables self-tracing when the SDK reports tracing inactive", async () => {
    mockIsTracingActive.mockReturnValue(false);
    const { withSelfTrace: guarded } = await freshEmitter();

    let calls = 0;
    const run = await guarded(meta(), async () => {
      calls += 1;
      return "verdict";
    });

    expect(calls).toBe(1);
    expect(run).toEqual({ ok: true, value: "verdict", selfTraced: false });
    expect(mockObserve).not.toHaveBeenCalled();
  });

  it("still propagates fn's failure once self-tracing is disabled", async () => {
    mockIsTracingActive.mockReturnValue(false);
    const { withSelfTrace: guarded } = await freshEmitter();

    const run = await guarded(meta(), async () => {
      throw new Error("eval exploded");
    });

    expect(run.ok).toBe(false);
    expect(run.selfTraced).toBe(false);
    if (!run.ok) expect((run.error as Error).message).toBe("eval exploded");
  });

  it("does not re-attempt initialization on later runs once disabled", async () => {
    mockIsTracingActive.mockReturnValue(false);
    const { withSelfTrace: guarded } = await freshEmitter();

    await guarded(meta(), async () => 1);
    await guarded(meta(), async () => 2);

    expect(mockInitialize).toHaveBeenCalledTimes(1);
    // The latch short-circuits ahead of the guard, not merely ahead of initialize().
    expect(mockIsTracingActive).toHaveBeenCalledTimes(1);
  });

  it("latches instead of retrying when SDK initialization throws", async () => {
    // initialize() fails on configuration or local provider setup — neither recovers
    // mid-process, so without a latch every run re-enters and logs again.
    mockInitialize.mockImplementation(() => {
      throw new TypeError("internalExport.path must start with '/'");
    });
    const { withSelfTrace: guarded, shutdownSelfTraceEmitter: shutdownGuarded } =
      await freshEmitter();

    const first = await guarded(meta(), async () => "verdict");
    // Counted, not inferred: a resolved value of 2 is equally consistent with fn having
    // run twice, and running a detector's evaluation twice is the costly failure here.
    const secondFn = vi.fn(async () => 2);
    const second = await guarded(meta(), secondFn);

    expect(first).toEqual({ ok: true, value: "verdict", selfTraced: false });
    expect(second).toEqual({ ok: true, value: 2, selfTraced: false });
    expect(secondFn).toHaveBeenCalledTimes(1);
    expect(mockObserve).not.toHaveBeenCalled();
    expect(mockInitialize).toHaveBeenCalledTimes(1);

    // The mirror of the disabled-tracing case: initialize() threw, so no provider,
    // exporter or batch processor exists (the SDK rolls its own back on a failed
    // register), and shutdown must not flush a pipeline that was never started.
    await shutdownGuarded();
    expect(mockFlush).not.toHaveBeenCalled();
    expect(mockShutdown).not.toHaveBeenCalled();
  });

  it("latches instead of retrying when the SDK has no isTracingActive", async () => {
    // An SDK predating the accessor throws here. Without latching, every run would
    // re-enter initialization and log twice for the life of the process.
    mockIsTracingActive.mockImplementation(() => {
      throw new TypeError("TraceRoot.isTracingActive is not a function");
    });
    const { withSelfTrace: guarded } = await freshEmitter();

    const first = await guarded(meta(), async () => "verdict");
    const secondFn = vi.fn(async () => 2);
    const second = await guarded(meta(), secondFn);

    expect(first).toEqual({ ok: true, value: "verdict", selfTraced: false });
    expect(second).toEqual({ ok: true, value: 2, selfTraced: false });
    expect(secondFn).toHaveBeenCalledTimes(1);
    expect(mockObserve).not.toHaveBeenCalled();
    expect(mockInitialize).toHaveBeenCalledTimes(1);
    expect(mockIsTracingActive).toHaveBeenCalledTimes(1);
  });

  it("still flushes and shuts down the SDK it started when the guard disabled tracing", async () => {
    // The check runs AFTER TraceRoot.initialize(), so the failure path leaves a live
    // provider, exporter and batch processor behind while self-tracing is off.
    // Shutdown keys off whether the SDK was started, not whether tracing stayed on.
    mockIsTracingActive.mockReturnValue(false);
    const { withSelfTrace: guarded, shutdownSelfTraceEmitter: shutdownGuarded } =
      await freshEmitter();

    const run = await guarded(meta(), async () => 1);
    expect(run.selfTraced).toBe(false);
    expect(mockInitialize).toHaveBeenCalledTimes(1);

    await shutdownGuarded();

    expect(mockFlush).toHaveBeenCalledTimes(1);
    expect(mockShutdown).toHaveBeenCalledTimes(1);
  });
});
