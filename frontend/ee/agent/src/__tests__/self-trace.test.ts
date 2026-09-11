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

  it("runs the turn untraced, exactly once, when observe rejects before reaching fn", async () => {
    // Tracing failing must never fail the run — the whole point of the latch.
    observe.mockRejectedValueOnce(new Error("span setup failed"));
    let calls = 0;
    const r = await mod.withAgentTrace(meta, async () => {
      calls += 1;
      return 5;
    });
    expect(r).toEqual({ value: 5, trace: "failed" });
    expect(calls).toBe(1);
  });

  it("runs the turn untraced, exactly once, when observe throws synchronously", async () => {
    // The real SDK throws synchronously on a bad forced trace id
    // (assertValidTraceId) before any span exists. That throw must land in
    // the same "fn never ran" branch as an async rejection — hoisting the
    // observe call out of the try would silently turn it into a 500.
    observe.mockImplementationOnce(() => {
      throw new TypeError("traceId must be 32 lowercase hex characters");
    });
    let calls = 0;
    const r = await mod.withAgentTrace(meta, async () => {
      calls += 1;
      return 5;
    });
    expect(r).toEqual({ value: 5, trace: "failed" });
    expect(calls).toBe(1);
  });

  it("rethrows fn's own error when tracing also fails on the way out, and logs the tracing error", async () => {
    // fn rejected, then observe's close-out threw something else. The caller
    // gets fn's error (it is theirs); the tracing failure must not vanish.
    const boom = new Error("agent blew up");
    const closeFail = new Error("span close failed");
    observe.mockImplementationOnce(async (_o: any, fn: any) => {
      try {
        await fn();
      } catch {
        // observe recorded fn's error; now its own close-out fails
      }
      throw closeFail;
    });
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    let calls = 0;
    await expect(
      mod.withAgentTrace(meta, async () => {
        calls += 1;
        throw boom;
      }),
    ).rejects.toBe(boom);
    expect(calls).toBe(1);
    expect(error).toHaveBeenCalledWith(expect.stringContaining("tracing failed"), closeFail);
    error.mockRestore();
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
  it("accepts 1 or true for the flag and nothing else", async () => {
    for (const [flag, on] of [
      ["1", true],
      ["true", true],
      ["0", false],
      ["yes", false],
      ["", false],
    ] as const) {
      process.env.AGENT_SELF_TRACE = flag;
      expect(mod.isAgentTraceEnabled("rca"), `AGENT_SELF_TRACE=${flag}`).toBe(on);
    }
  });
  it("respects the per-kind list", async () => {
    process.env.AGENT_SELF_TRACE_KINDS = "rca,followup";
    expect(mod.isAgentTraceEnabled("chat")).toBe(false);
    expect(mod.isAgentTraceEnabled("rca")).toBe(true);
  });
  it("warns once per unknown kind token instead of silently ignoring it", async () => {
    // An operator's typo in a staged rollout must be visible: the token is
    // ignored (so nothing is traced by accident) and warned about once, not
    // on every turn.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    process.env.AGENT_SELF_TRACE_KINDS = "rca, RCA,follow-up";
    expect(mod.isAgentTraceEnabled("rca")).toBe(true);
    expect(mod.isAgentTraceEnabled("followup")).toBe(false);
    mod.isAgentTraceEnabled("chat");
    const warnedAbout = warn.mock.calls.map((c) => c[0]);
    expect(warnedAbout).toHaveLength(2);
    expect(warnedAbout[0]).toContain('"RCA"');
    expect(warnedAbout[1]).toContain('"follow-up"');
    warn.mockRestore();
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

  it("stamps the trace-level metadata on the root, before the run, so ingest promotes it", async () => {
    // observe() only sets the span-level metadata; the trace record's
    // metadata (what the viewer reads) comes from traceroot.trace.metadata.
    const setAttribute = vi.fn();
    const { trace } = await import("@opentelemetry/api");
    const spy = vi.spyOn(trace, "getActiveSpan").mockReturnValue({ setAttribute } as never);
    const rcaMeta = {
      ...meta,
      metadata: { finding_id: "f1", attempt: 2, scanned_trace_id: "b".repeat(32) },
    };
    await expect(
      mod.withAgentTrace(rcaMeta, async () => {
        // Already stamped when fn starts: a failed run keeps it.
        expect(Object.fromEntries(setAttribute.mock.calls)["traceroot.trace.metadata"]).toBe(
          JSON.stringify({ kind: "rca", ...rcaMeta.metadata }),
        );
        throw new Error("run failed");
      }),
    ).rejects.toThrow("run failed");
    // Same document observe() got for the span-level metadata.
    expect(observe.mock.calls[0][0].metadata).toEqual({ kind: "rca", ...rcaMeta.metadata });
    spy.mockRestore();
  });

  it("marks the root ERROR when the run resolved with an error", async () => {
    // The route resolves (not rejects) when the agent fails, so its rows still
    // persist; the root span must not read as a successful run.
    const root = { setAttribute: vi.fn(), setStatus: vi.fn(), recordException: vi.fn() };
    const { trace } = await import("@opentelemetry/api");
    const { SpanStatusCode } = await import("@opentelemetry/api");
    const spy = vi.spyOn(trace, "getActiveSpan").mockReturnValue(root as never);
    const failure = new Error("provider 529");
    const r = await mod.withAgentTrace(meta, async () => ({ error: failure }), {
      runError: (v) => v.error,
    });
    expect(r.trace).toBe("available");
    expect(root.recordException).toHaveBeenCalledWith(failure);
    expect(root.setStatus).toHaveBeenCalledWith({
      code: SpanStatusCode.ERROR,
      message: "provider 529",
    });
    spy.mockRestore();
  });

  it("leaves the root status alone when the run resolved cleanly", async () => {
    const root = { setAttribute: vi.fn(), setStatus: vi.fn(), recordException: vi.fn() };
    const { trace } = await import("@opentelemetry/api");
    const spy = vi.spyOn(trace, "getActiveSpan").mockReturnValue(root as never);
    await mod.withAgentTrace(meta, async () => ({ error: undefined }), {
      runError: (v) => v.error,
    });
    expect(root.setStatus).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});

describe("withAgentTrace run scope", () => {
  it("exposes the tool-span map and capture budget inside the run, and nothing outside", async () => {
    expect(mod.currentToolSpanIds()).toBeUndefined();
    expect(mod.currentCaptureState()).toBeUndefined();
    let seenInside: { ids: Map<string, string> | undefined; state: unknown } | undefined;
    await mod.withAgentTrace(meta, async () => {
      // What the SDK's onToolSpan hook does for each tool call...
      mod.recordToolSpan({ toolCallId: "call-1", spanId: "abcdef0123456789" });
      // ...and what the persister and captureToolIo read back.
      seenInside = { ids: mod.currentToolSpanIds(), state: mod.currentCaptureState() };
      return 1;
    });
    expect(seenInside?.ids?.get("call-1")).toBe("abcdef0123456789");
    expect(seenInside?.state).toEqual({ spentBytes: 0 });
    expect(mod.currentToolSpanIds()).toBeUndefined();
    expect(mod.currentCaptureState()).toBeUndefined();
  });

  it("gives every run its own map and budget", async () => {
    const seen: Array<Map<string, string> | undefined> = [];
    await Promise.all([
      mod.withAgentTrace(meta, async () => {
        mod.recordToolSpan({ toolCallId: "a", spanId: "1" });
        await new Promise((r) => setTimeout(r, 1));
        seen.push(mod.currentToolSpanIds());
      }),
      mod.withAgentTrace(meta, async () => {
        mod.recordToolSpan({ toolCallId: "b", spanId: "2" });
        seen.push(mod.currentToolSpanIds());
      }),
    ]);
    expect(seen.map((m) => [...m!.keys()])).toEqual([["b"], ["a"]]);
  });

  it("runs an untraced turn outside the scope", async () => {
    process.env.AGENT_SELF_TRACE = "0";
    let inside: unknown = "unset";
    await mod.withAgentTrace(meta, async () => {
      inside = mod.currentToolSpanIds();
    });
    expect(inside).toBeUndefined();
  });
});

describe("withAgentTrace flush", () => {
  it("serialises flushes so a rejection lands on the turn whose spans were in flight", async () => {
    // TraceRoot.flush() is process-wide. Two turns flushing at once would
    // share one forceFlush, and whichever awaited it would take the blame.
    let inFlight = 0;
    let maxInFlight = 0;
    const gates: Array<() => void> = [];
    flush.mockImplementation(
      () =>
        new Promise<void>((resolve, reject) => {
          inFlight += 1;
          maxInFlight = Math.max(maxInFlight, inFlight);
          gates.push(() => {
            inFlight -= 1;
            // The first flush fails, the second succeeds.
            if (gates.length === 1) reject(new Error("export 502"));
            else resolve();
          });
        }),
    );
    const a = mod.withAgentTrace(meta, async () => "a");
    const b = mod.withAgentTrace({ ...meta, traceId: "b".repeat(32) }, async () => "b");
    // Let both turns reach their flush.
    await new Promise((r) => setTimeout(r, 0));
    expect(flush).toHaveBeenCalledTimes(1); // b is queued behind a
    gates[0]!();
    await expect(a).resolves.toEqual({ value: "a", trace: "failed" });
    await new Promise((r) => setTimeout(r, 0));
    expect(flush).toHaveBeenCalledTimes(2);
    gates[1]!();
    await expect(b).resolves.toEqual({ value: "b", trace: "available" });
    expect(maxInFlight).toBe(1);
  });

  it("keeps the queue chained to the flush's real settlement, not to its timeout", async () => {
    // A timeout only stops THIS caller from waiting — it must not let the
    // queue move on while the process-wide TraceRoot.flush() it started is
    // still running, or the next queued flush can start and overlap it,
    // resurrecting the cross-turn attribution race serialisation exists to
    // prevent. Mock flush() as never settling on its own; the test settles
    // each call by hand so it can assert on what happened in between.
    vi.useFakeTimers();
    try {
      const deferred: Array<() => void> = [];
      flush.mockImplementation(
        () =>
          new Promise<void>((resolve) => {
            deferred.push(resolve);
          }),
      );

      const a = mod.withAgentTrace(meta, async () => "a");
      await vi.advanceTimersByTimeAsync(0); // let turn a reach its flush
      expect(flush).toHaveBeenCalledTimes(1);

      // The 30s flush timeout fires: the caller sees a failure...
      await vi.advanceTimersByTimeAsync(30_000);
      await expect(a).resolves.toEqual({ value: "a", trace: "failed" });

      // ...but the real flush() call it started is still pending (deferred[0]
      // untouched), so a second turn's flush must not start yet.
      const b = mod.withAgentTrace({ ...meta, traceId: "b".repeat(32) }, async () => "b");
      await vi.advanceTimersByTimeAsync(0);
      expect(flush).toHaveBeenCalledTimes(1); // b's flush has NOT started

      // Only once turn a's real flush() finally settles (a slow export
      // completing well after its own caller stopped waiting) does the queue
      // advance and let turn b's flush begin.
      deferred[0]!();
      await vi.advanceTimersByTimeAsync(0);
      expect(flush).toHaveBeenCalledTimes(2);

      deferred[1]!();
      await expect(b).resolves.toEqual({ value: "b", trace: "available" });
    } finally {
      vi.useRealTimers();
    }
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
