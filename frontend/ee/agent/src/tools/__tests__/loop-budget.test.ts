import { describe, expect, it, vi } from "vitest";
import { Agent, type AgentTool, type AgentToolResult } from "@earendil-works/pi-agent-core";
import {
  Type,
  createFauxCore,
  fauxAssistantMessage,
  fauxToolCall,
  type Context,
} from "@earendil-works/pi-ai";
import { LOOP_LIMITS } from "@traceroot/core/loops/pure";
import {
  BLOCKED_CALLS_BEFORE_STOP,
  RECORD_FINDING_TOOL,
  SUBMIT_SUMMARY_TOOL,
  findingRecordCap,
  newLoopRunState,
  withBudget,
  type LoopBudgetLimits,
  type LoopRunState,
} from "../loop/budget.js";

const schema = Type.Object({});

function fakeTool(name: string): AgentTool<typeof schema> & { execute: ReturnType<typeof vi.fn> } {
  return {
    name,
    label: name,
    description: name,
    parameters: schema,
    execute: vi.fn(
      async (): Promise<AgentToolResult<undefined>> => ({
        content: [{ type: "text", text: `${name} ran` }],
        details: undefined,
      }),
    ),
  };
}

const LIMITS: LoopBudgetLimits = {
  toolCalls: LOOP_LIMITS.toolCalls,
  traceReads: LOOP_LIMITS.traceReads,
  findingRecords: 6,
};

function budgeted(
  state: LoopRunState,
  limits: LoopBudgetLimits = LIMITS,
  onRunaway: () => void = () => {},
) {
  const tools = new Map<string, ReturnType<typeof fakeTool>>();
  const call = (name: string) => {
    if (!tools.has(name)) tools.set(name, fakeTool(name));
    const inner = tools.get(name)!;
    return withBudget(inner, state, onRunaway, limits).execute(`tc-${name}`, {});
  };
  return { call, ran: (name: string) => tools.get(name)?.execute.mock.calls.length ?? 0 };
}

const textOf = (result: AgentToolResult<unknown>) =>
  result.content.map((block) => (block.type === "text" ? block.text : "")).join("");

describe("withBudget", () => {
  it("lets 80 tool calls run and refuses the 81st, telling the model to submit", async () => {
    const state = newLoopRunState();
    const { call, ran } = budgeted(state);
    for (let i = 0; i < 80; i++) {
      expect(textOf(await call("list_traces"))).toBe("list_traces ran");
    }
    expect(state.toolCalls).toBe(80);
    const refused = textOf(await call("list_traces"));
    expect(refused).toContain("80 of its tool calls");
    expect(refused).toContain(SUBMIT_SUMMARY_TOOL);
    expect(ran("list_traces")).toBe(80);
    expect(state.toolCalls).toBe(80);
    expect(state.budgetExhausted).toBe(true);
  });

  it("lets 25 trace reads run (get_trace and get_session) and refuses the 26th", async () => {
    const state = newLoopRunState();
    const { call, ran } = budgeted(state);
    for (let i = 0; i < 25; i++) await call(i % 2 ? "get_trace" : "get_session");
    expect(state.tracesRead).toBe(25);
    expect(textOf(await call("get_trace"))).toContain("25 of its trace reads");
    expect(ran("get_trace") + ran("get_session")).toBe(25);
    expect(state.tracesRead).toBe(25);
    // Other reads still run while the tool-call budget lasts.
    expect(textOf(await call("list_signals"))).toBe("list_signals ran");
  });

  it("never refuses the summary, even over budget", async () => {
    const state = newLoopRunState();
    const { call, ran } = budgeted(state, { ...LIMITS, toolCalls: 1, traceReads: 1 });
    await call("list_traces");
    expect(textOf(await call("list_traces"))).toContain("Budget reached");
    await call(SUBMIT_SUMMARY_TOOL);
    expect(ran(SUBMIT_SUMMARY_TOOL)).toBe(1);
  });

  it("never refuses recording a finding over the tool-call cap, so a run can still hand it over", async () => {
    const state = newLoopRunState();
    const { call, ran } = budgeted(state, { ...LIMITS, toolCalls: 1, traceReads: 1 });
    await call("list_traces");
    expect(textOf(await call("list_traces"))).toContain(RECORD_FINDING_TOOL);
    expect(textOf(await call(RECORD_FINDING_TOOL))).toBe(`${RECORD_FINDING_TOOL} ran`);
    expect(ran(RECORD_FINDING_TOOL)).toBe(1);
  });

  it("allows three record calls per key the run may record, up to the findings cap", () => {
    expect(findingRecordCap(2, 0)).toBe(6);
    expect(findingRecordCap(1, 3)).toBe(12);
    // However many keys the Loop has, a run records at most findingsPerRun of them.
    expect(findingRecordCap(2, 500)).toBe(3 * LOOP_LIMITS.findingsPerRun);
  });

  it("refuses loop_record_finding past its own cap and stops a run that spins on it", async () => {
    const onRunaway = vi.fn();
    const state = newLoopRunState();
    const { call, ran } = budgeted(state, { ...LIMITS, findingRecords: 2 }, onRunaway);
    await call(RECORD_FINDING_TOOL);
    await call(RECORD_FINDING_TOOL);
    const refused = textOf(await call(RECORD_FINDING_TOOL));
    expect(refused).toContain(`all 2 of its ${RECORD_FINDING_TOOL} calls`);
    expect(refused).toContain(SUBMIT_SUMMARY_TOOL);
    expect(ran(RECORD_FINDING_TOOL)).toBe(2);
    expect(state.findingRecords).toBe(2);
    // Other tools still run, and the summary is never refused.
    expect(textOf(await call("list_traces"))).toBe("list_traces ran");
    expect(textOf(await call(SUBMIT_SUMMARY_TOOL))).toBe(`${SUBMIT_SUMMARY_TOOL} ran`);
    for (let i = 1; i < BLOCKED_CALLS_BEFORE_STOP; i++) await call(RECORD_FINDING_TOOL);
    expect(onRunaway).toHaveBeenCalledTimes(1);
  });

  it("asks the caller to stop the run once, when the model keeps calling past the cap", async () => {
    const onRunaway = vi.fn();
    const state = newLoopRunState();
    const { call } = budgeted(state, { ...LIMITS, toolCalls: 0, traceReads: 0 }, onRunaway);
    for (let i = 0; i < BLOCKED_CALLS_BEFORE_STOP - 1; i++) await call("list_traces");
    expect(onRunaway).not.toHaveBeenCalled();
    await call("list_traces");
    await call("list_traces");
    expect(onRunaway).toHaveBeenCalledTimes(1);
  });

  it("counts before awaiting, so calls started together cannot all pass the cap", async () => {
    const state = newLoopRunState();
    const { call, ran } = budgeted(state, { ...LIMITS, toolCalls: 2, traceReads: 2 });
    await Promise.all([call("get_trace"), call("get_trace"), call("get_trace")]);
    expect(ran("get_trace")).toBe(2);
    expect(state.blockedCalls).toBe(1);
  });

  it("hands a refused call to the model as that call's tool result", async () => {
    // A real agent loop on a scripted model: one batch of two parallel calls
    // with room for one, then the model answers after reading the results.
    const faux = createFauxCore({ provider: "faux-budget" });
    let seen: Context | undefined;
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("get_trace", {}), fauxToolCall("get_trace", {})], {
        stopReason: "toolUse",
      }),
      (context) => {
        seen = context;
        return fauxAssistantMessage("done");
      },
    ]);
    const state = newLoopRunState();
    const inner = fakeTool("get_trace");
    const agent = new Agent({
      initialState: {
        model: faux.getModel(),
        systemPrompt: "",
        tools: [withBudget(inner, state, () => {}, { ...LIMITS, toolCalls: 10, traceReads: 1 })],
      },
      streamFn: faux.streamSimple,
    });

    await agent.prompt("go");

    const results = (seen?.messages ?? []).filter((m) => m.role === "toolResult");
    expect(results).toHaveLength(2);
    const texts = results.map((m) => (m.content[0].type === "text" ? m.content[0].text : ""));
    expect(texts).toContain("get_trace ran");
    expect(texts.find((t) => t !== "get_trace ran")).toContain(`then call ${SUBMIT_SUMMARY_TOOL}`);
    expect(inner.execute).toHaveBeenCalledTimes(1);
  });
});
