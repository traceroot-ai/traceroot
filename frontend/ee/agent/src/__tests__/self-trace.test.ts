import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const initialize = vi.fn();
const flush = vi.fn(async () => {});
const observe = vi.fn(async (_opts: any, fn: any) => fn());
const tracingActive = { value: true };
vi.mock("@traceroot-ai/traceroot", () => ({
  TraceRoot: {
    initialize: (...a: unknown[]) => initialize(...a),
    flush: (...a: unknown[]) => flush(...a),
    isTracingActive: () => tracingActive.value,
  },
  observe: (...a: unknown[]) => observe(...a),
  instrumentPiAgentCore: vi.fn(),
}));

let mod: typeof import("../self-trace.js");
beforeEach(async () => {
  vi.resetModules();
  initialize.mockReset();
  flush.mockReset().mockResolvedValue(undefined);
  observe.mockClear();
  tracingActive.value = true;
  process.env.INTERNAL_API_SECRET_AGENT = "s";
  process.env.AGENT_SELF_TRACE = "1";
  delete process.env.AGENT_SELF_TRACE_KINDS;
  mod = await import("../self-trace.js");
});
afterEach(() => {
  delete process.env.AGENT_SELF_TRACE;
  delete process.env.AGENT_SELF_TRACE_KINDS;
});

const meta = {
  traceId: "a".repeat(32),
  projectId: "p1",
  kind: "rca" as const,
  name: "rca: x",
  metadata: {},
};

describe("withAgentTrace", () => {
  it("keeps a completed turn when tracing fails on the way out", async () => {
    // fn succeeded; observe then threw while closing spans. Treating that as
    // fn's failure would abort a turn that already worked — and the caller
    // would never see the answer the agent produced.
    observe.mockImplementationOnce(async (_o: any, fn: any) => {
      await fn();
      throw new Error("span close failed");
    });
    const r = await mod.withAgentTrace(meta, async () => 99);
    expect(r).toEqual({ value: 99, trace: "failed" });
  });

  it("does not rerun a turn that already ran", async () => {
    // The untraced-fallback path must only fire when fn never started.
    let calls = 0;
    observe.mockImplementationOnce(async (_o: any, fn: any) => {
      await fn();
      throw new Error("span close failed");
    });
    await mod.withAgentTrace(meta, async () => {
      calls += 1;
      return 1;
    });
    expect(calls).toBe(1);
  });

  it("latches off when the SDK initialized but tracing never became active", async () => {
    // initialize() not throwing does not mean spans flow: the SDK no-ops when
    // disabled, and declines to register when another provider owns the global.
    // Acking `available` there would publish links to traces that don't exist.
    tracingActive.value = false;
    const r = await mod.withAgentTrace(meta, async () => 7);
    expect(r).toEqual({ value: 7, trace: "disabled" });
    expect(observe).not.toHaveBeenCalled();
  });

  it("runs the turn untraced when observe fails before reaching fn", async () => {
    // Tracing failing must never fail the run — the whole point of the latch.
    observe.mockRejectedValueOnce(new Error("forced-id validation failed"));
    const r = await mod.withAgentTrace(meta, async () => 5);
    expect(r).toEqual({ value: 5, trace: "failed" });
  });

  it("still propagates fn's own error", async () => {
    // Once fn has entered, a rejection is the caller's failure, not tracing's.
    const boom = new Error("agent blew up");
    await expect(
      mod.withAgentTrace(meta, async () => {
        throw boom;
      }),
    ).rejects.toBe(boom);
  });

  it("runs fn inside observe with the forced trace id and returns available after flush", async () => {
    const r = await mod.withAgentTrace(meta, async () => 42);
    expect(r).toEqual({ value: 42, trace: "available" });
    expect(observe.mock.calls[0][0]).toMatchObject({
      traceId: meta.traceId,
      projectId: "p1",
      name: "rca: x",
    });
    expect(initialize).toHaveBeenCalledWith(
      expect.objectContaining({
        internalExport: expect.objectContaining({
          path: "/api/v1/internal/traces",
          headers: { "X-Internal-Secret": "s" },
        }),
      }),
    );
  });
  it("returns failed when flush rejects, but fn's value is kept", async () => {
    flush.mockRejectedValueOnce(new Error("export 403"));
    const r = await mod.withAgentTrace(meta, async () => "v");
    expect(r).toEqual({ value: "v", trace: "failed" });
  });
  it("returns disabled and runs fn plainly when the flag is off", async () => {
    process.env.AGENT_SELF_TRACE = "0";
    const r = await mod.withAgentTrace(meta, async () => "v");
    expect(r.trace).toBe("disabled");
    expect(observe).not.toHaveBeenCalled();
  });
  it("respects the per-kind list", async () => {
    process.env.AGENT_SELF_TRACE_KINDS = "rca,followup";
    expect(mod.isAgentTraceEnabled("chat")).toBe(false);
    expect(mod.isAgentTraceEnabled("rca")).toBe(true);
  });
  it("latches to disabled when initialize throws, and never re-tries", async () => {
    initialize.mockImplementation(() => {
      throw new Error("bad config");
    });
    expect((await mod.withAgentTrace(meta, async () => 1)).trace).toBe("disabled");
    expect((await mod.withAgentTrace(meta, async () => 2)).trace).toBe("disabled");
    expect(initialize).toHaveBeenCalledTimes(1);
  });
  it("turnTraceId is 32 hex and deterministic", () => {
    expect(mod.turnTraceId("s", "m")).toMatch(/^[0-9a-f]{32}$/);
    expect(mod.turnTraceId("s", "m")).toBe(mod.turnTraceId("s", "m"));
  });
});

describe("withAgentTrace root I/O", () => {
  it("records the input and the final output on the root span, redacted and capped", async () => {
    const setAttribute = vi.fn();
    const { trace } = await import("@opentelemetry/api");
    const spy = vi.spyOn(trace, "getActiveSpan").mockReturnValue({ setAttribute } as never);
    const r = await mod.withAgentTrace(
      { ...meta, input: "why did it fail? token ghp_" + "x".repeat(40) },
      async () => "done",
      { recordOutput: (v) => `answer: ${v} ` + "y".repeat(20_000) },
    );
    expect(r.trace).toBe("available");
    const calls = Object.fromEntries(setAttribute.mock.calls);
    expect(calls["traceroot.span.input"]).toContain("ghp_[REDACTED]");
    expect(calls["traceroot.span.output"].startsWith("answer: done")).toBe(true);
    expect(calls["traceroot.span.output"].length).toBeLessThanOrEqual(16_385);
    spy.mockRestore();
  });
});

describe("rcaSpanName", () => {
  it("names the detector when exactly one fired", () => {
    expect(mod.rcaSpanName(["Hallucination Detector"])).toBe("rca: Hallucination Detector");
  });

  it("counts instead of listing once more than one fired", () => {
    expect(mod.rcaSpanName(["Hallucination Detector", "Failure Detector"])).toBe(
      "rca: 2 detectors",
    );
    expect(mod.rcaSpanName(["a", "b", "c", "d", "e"])).toBe("rca: 5 detectors");
  });

  it("stays bounded when a single detector has a long name", () => {
    const name = mod.rcaSpanName([`Detector ${"x".repeat(200)}`]);
    expect(name.length).toBeLessThanOrEqual("rca: ".length + 40);
    expect(name.endsWith("…")).toBe(true);
  });

  it("falls back to a bare kind when the list is missing or empty", () => {
    expect(mod.rcaSpanName(undefined)).toBe("rca");
    expect(mod.rcaSpanName([])).toBe("rca");
    expect(mod.rcaSpanName(["  "])).toBe("rca");
  });
});
