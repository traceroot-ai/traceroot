import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentEvent } from "@earendil-works/pi-agent-core";

/**
 * Drives ONE tool event through both real capture-policy consumers this PR
 * wires together — the SDK's per-tool span callback (agent.ts's
 * captureToolIo, backed by self-trace.ts's run-scoped captureState) and a
 * StreamPersister mirroring the same event into an AIMessage row — and
 * asserts each sink is bounded by its OWN budget.
 *
 * Before the fix, index.ts handed the persister the exact accumulator the
 * span callback charges (currentCaptureState()), so the two sinks shared one
 * perRunBytes budget instead of each getting their own. agent-instrumentation
 * .test.ts and stream-persister.test.ts each drive their own consumer in
 * isolation and can't see that — this test exercises both against the same
 * event, the way index.ts wires them.
 */
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
// neither is exercised here (same stubs as agent-instrumentation.test.ts).
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
  captureToolIo: (
    toolName: string,
    args: unknown,
    result: unknown,
  ) => { args: unknown; result: unknown };
};

let selfTrace: typeof import("../self-trace.js");
let StreamPersister: typeof import("../stream-persister.js").StreamPersister;
let config: Config;

beforeEach(async () => {
  vi.resetModules();
  instrumentPiAgentCore.mockClear();
  process.env.INTERNAL_API_SECRET_AGENT = "s";
  process.env.AGENT_SELF_TRACE = "1";
  delete process.env.AGENT_SELF_TRACE_KINDS;
  selfTrace = await import("../self-trace.js");
  await import("../agent.js");
  ({ StreamPersister } = await import("../stream-persister.js"));
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

describe("span sink and row sink capture budgets are independent", () => {
  it("a near-exhausted span budget does not starve the row sink's own budget for the same event", async () => {
    // download_traces is output-allowlisted, so both args and result actually
    // spend budget for this tool (most tools only spend on args) — the shape
    // the review's finding is about.
    const toolName = "download_traces";
    const args = { traceId: "t1" };
    const result = "small result body";

    let rowMetadata: Record<string, unknown> | undefined;
    const rowState = { spentBytes: 0 };
    const persister = new StreamPersister(
      async (_role, _content, metadata) => {
        rowMetadata = metadata;
      },
      { state: rowState },
    );

    let spanClose: { args: unknown; result: unknown } | undefined;

    await selfTrace.withAgentTrace(meta, async () => {
      // Simulate the span sink having already spent its whole perRunBytes
      // budget on earlier tool calls this run (DEFAULT_CAPTURE_BUDGET.
      // perRunBytes is 262_144 — see capture-policy.ts).
      const spanState = selfTrace.currentCaptureState()!;
      spanState.spentBytes = 262_144;

      // The vendored SDK's own call pattern: captureToolIo once at span open
      // (args only) and once at span close (result only) — both hit the
      // now-near-exhausted span budget.
      config.captureToolIo(toolName, args, undefined);
      spanClose = config.captureToolIo(toolName, undefined, result);

      // The SAME event, mirrored into a row by the persister — a completely
      // separate accumulator (rowState), never currentCaptureState().
      persister.onEvent({
        type: "tool_execution_start",
        toolCallId: "1",
        toolName,
        args,
      } as AgentEvent);
      persister.onEvent({
        type: "tool_execution_end",
        toolCallId: "1",
        toolName,
        result,
        isError: false,
      } as AgentEvent);
    });
    await persister.finish();

    // The span sink is out of budget: its close call reports the result withheld.
    expect(String(spanClose!.result)).toContain("[withheld:");

    // The row sink, with its own fresh budget, captured the same result in
    // full — proof the two sinks don't share one accumulator. Under the old
    // shared-state bug this would also have come back withheld.
    expect(rowMetadata?.result).toBe(result);
    expect(rowMetadata?.withheld).toBeUndefined();
    expect(rowState.spentBytes).toBeGreaterThan(0);
    expect(rowState.spentBytes).toBeLessThan(262_144);
  });
});
