import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const initialize = vi.fn();
const flush = vi.fn(async () => {});
const observe = vi.fn(async (_opts: any, fn: any) => fn());
vi.mock("@traceroot-ai/traceroot", () => ({
  TraceRoot: {
    initialize: (...a: unknown[]) => initialize(...a),
    flush: (...a: unknown[]) => flush(...a),
    isTracingActive: () => true,
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
