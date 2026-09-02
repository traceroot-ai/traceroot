import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Imports the REAL agent.ts (every other agent test mocks it away) to pin how
// the SDK's pi-agent-core instrumentation is wired: content capture off, tool
// I/O through the capture policy on the run's shared budget, tool span ids
// reported into the run scope.
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

type Config = {
  captureContent: boolean;
  captureToolIo: (
    toolName: string,
    args: unknown,
    result: unknown,
  ) => { args: unknown; result: unknown };
  onToolSpan: (info: { toolCallId: string; spanId: string; toolName: string }) => void;
};

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
});

const meta = {
  traceId: "a".repeat(32),
  projectId: "p1",
  kind: "rca" as const,
  name: "rca",
  metadata: {},
};

describe("agent.ts instrumentation wiring", () => {
  it("installs the pi-agent-core instrumentation once, with content capture off", async () => {
    const piAgentCore = await import("@earendil-works/pi-agent-core");
    expect(instrumentPiAgentCore).toHaveBeenCalledTimes(1);
    expect(instrumentPiAgentCore.mock.calls[0]![0]).toBe(piAgentCore);
    expect(config).toMatchObject({
      captureContent: false,
      captureToolIo: expect.any(Function),
      onToolSpan: expect.any(Function),
    });
  });

  it("runs tool I/O through the capture policy: redacted, and withheld past the per-step cap", () => {
    const out = config.captureToolIo(
      "get_traces",
      { token: "ghp_" + "x".repeat(40) },
      "y".repeat(200_000),
    );
    expect(JSON.stringify(out.args)).toContain("[REDACTED]");
    expect(JSON.stringify(out.args)).not.toContain("x".repeat(40));
    // The policy withholds a result over the cap and the closure substitutes
    // a marker (the SDK would otherwise stamp `undefined`).
    expect(typeof out.result).toBe("string");
    expect((out.result as string).length).toBeLessThan(200_000);
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
      config.captureToolIo("get_traces", { q: "x" }, "y".repeat(1000));
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
