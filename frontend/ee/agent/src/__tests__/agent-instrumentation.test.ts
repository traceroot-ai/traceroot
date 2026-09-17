import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Imports the REAL agent.ts (every other agent test mocks it away) to pin how
// the SDK's pi-agent-core instrumentation is wired: content capture through
// llm-content.ts (never the raw boolean form), tool I/O through the capture
// policy on the run's shared budget, tool span ids reported into the run scope.
const instrumentPiAgentCore = vi.fn();
vi.mock("@traceroot-ai/traceroot", () => ({
  TraceRoot: {
    initialize: vi.fn(),
    flush: vi.fn(async () => {}),
    isTracingActive: () => true,
  },
  observe: vi.fn(async (_opts: unknown, fn: () => unknown) => fn()),
  instrumentPiAgentCore: (...a: unknown[]) => instrumentPiAgentCore(...a),
}));
// agent.ts pulls in the Prisma client and the model resolver at import time;
// neither is exercised here.
vi.mock("@traceroot/core", () => ({
  ADAPTER_TO_PI_AI: {},
  BEDROCK_USE_DEFAULT_CREDENTIALS: "bedrock-default",
  ModelSource: { SYSTEM: "system", BYOK: "byok" },
}));
vi.mock("@traceroot/core/model-resolver", () => ({
  resolvePiModel: vi.fn(),
  fetchProviderConfig: vi.fn(),
  findByokKeyForPiProvider: vi.fn(),
  invalidateProviderConfigCache: vi.fn(),
}));
vi.mock("../session.js", () => ({ SessionManager: class {} }));

type Ctx = { toolCallId: string; attributes: Record<string, unknown> };
type Config = {
  captureContent: (kind: string, value: Record<string, unknown>, ctx: Ctx) => string | undefined;
  captureToolIo: {
    args: (toolName: string, args: unknown, ctx: Ctx) => unknown;
    result: (toolName: string, result: unknown, ctx: Ctx) => string | undefined;
  };
  onToolSpan: (info: { toolCallId: string; spanId: string; toolName: string }) => void;
};

/** Both sides of one tool call through the wired capture, with what each asked to set on the span. */
function captureToolIo(toolName: string, args: unknown, result: unknown) {
  const ctx: Ctx = { toolCallId: "tc1", attributes: {} };
  return {
    args: config.captureToolIo.args(toolName, args, ctx),
    result: config.captureToolIo.result(toolName, result, ctx),
    attributes: ctx.attributes,
  };
}

let selfTrace: typeof import("../self-trace.js");
let config: Config;
beforeEach(async () => {
  vi.resetModules();
  instrumentPiAgentCore.mockClear();
  process.env.INTERNAL_API_SECRET_AGENT = "s";
  process.env.AGENT_SELF_TRACE = "1";
  delete process.env.AGENT_SELF_TRACE_KINDS;
  selfTrace = await import("../self-trace.js");
  await import("../agent.js");
  config = instrumentPiAgentCore.mock.calls[0]![1] as Config;
});
afterEach(() => {
  delete process.env.AGENT_SELF_TRACE;
  delete process.env.INTERNAL_API_SECRET_AGENT;
});

const meta = {
  traceId: "a".repeat(32),
  projectId: "p1",
  kind: "rca" as const,
  name: "rca",
  metadata: {},
};

describe("agent.ts instrumentation wiring", () => {
  it("installs the pi-agent-core instrumentation once, with content capture through the policy", async () => {
    const piAgentCore = await import("@earendil-works/pi-agent-core");
    expect(instrumentPiAgentCore).toHaveBeenCalledTimes(1);
    expect(instrumentPiAgentCore.mock.calls[0]![0]).toBe(piAgentCore);
    expect(config).toMatchObject({
      agentSpan: "unless-nested",
      captureContent: expect.any(Function),
      captureToolIo: { args: expect.any(Function), result: expect.any(Function) },
      onToolSpan: expect.any(Function),
    });
  });

  it("runs tool I/O through the capture policy: redacted args, and a kept result cut at the per-step cap", () => {
    // download_traces is allow-listed, so this exercises the cut on a kept
    // result rather than the withholding of a non-allow-listed one.
    const out = captureToolIo(
      "download_traces",
      { token: "ghp_" + "x".repeat(40) },
      "y".repeat(200_000),
    );
    expect(JSON.stringify(out.args)).toContain("[REDACTED]");
    expect(JSON.stringify(out.args)).not.toContain("x".repeat(40));
    expect(typeof out.result).toBe("string");
    expect(Buffer.byteLength(out.result as string, "utf8")).toBeLessThanOrEqual(8_192);
    expect((out.result as string).endsWith("…")).toBe(true);
    // The cut is marked on the span (design B7), and the budget was not the reason.
    expect(out.attributes).toEqual({ "traceroot.truncated": true });
  });

  it("marks a span whose result the run's spent budget withheld (design B8)", async () => {
    await selfTrace.withAgentTrace(meta, async () => {
      selfTrace.currentCaptureState()!.spentBytes = 262_144;
      const out = captureToolIo("download_traces", { q: "x" }, "y".repeat(100));
      expect(out.attributes).toMatchObject({ "traceroot.capture_budget_exceeded": true });
      expect(out.result).toContain("Output not stored: this run reached");
    });
  });

  it("marks nothing on a tool span whose I/O was kept whole", () => {
    const out = captureToolIo("download_traces", { q: "x" }, "y".repeat(100));
    expect(out.attributes).toEqual({});
  });

  it("stamps a withheld result as the reader-facing note the chat step shows, not the policy's verdict", () => {
    const out = captureToolIo("bash", { command: "ls" }, "a listing of 26 bytes.....");
    expect(out.result).toBe(
      "Output not stored after the run (26 bytes returned). Shell, file and git output can " +
        "include your source code and secrets, so it is shown while the run streams but not " +
        "kept afterwards. Trace and session downloads are kept.",
    );
  });

  it("charges the run's SPAN budget — independent of the row budget the persister keeps for itself", async () => {
    // See capture-budget-independence.test.ts for the cross-sink assertion:
    // this only pins that the callback charges currentCaptureState() (the
    // span accumulator), not that anything about rows follows from it.
    let before: number | undefined;
    let after: number | undefined;
    await selfTrace.withAgentTrace(meta, async () => {
      const state = selfTrace.currentCaptureState()!;
      before = state.spentBytes;
      captureToolIo("get_traces", { q: "x" }, "y".repeat(1000));
      after = state.spentBytes;
    });
    expect(before).toBe(0);
    expect(after!).toBeGreaterThan(0);
  });

  it("reports tool span ids into the run scope for the persister to stamp", async () => {
    let ids: Map<string, string> | undefined;
    await selfTrace.withAgentTrace(meta, async () => {
      config.onToolSpan({ toolCallId: "call-1", spanId: "abcdef0123456789", toolName: "t" });
      ids = selfTrace.currentToolSpanIds();
    });
    expect(ids?.get("call-1")).toBe("abcdef0123456789");
    // Outside a run the hook is a no-op rather than a throw.
    expect(() =>
      config.onToolSpan({ toolCallId: "call-2", spanId: "0", toolName: "t" }),
    ).not.toThrow();
  });
});
