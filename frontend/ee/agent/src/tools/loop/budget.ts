import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { TSchema } from "@earendil-works/pi-ai";
import { LOOP_LIMITS } from "@traceroot/core/loops/pure";

/** The tool that ends a run; it is never refused, so a run over budget can still report. */
export const SUBMIT_SUMMARY_TOOL = "loop_submit_summary";

/** Reads that open one trace's (or one session's traces') content. */
export const TRACE_READ_TOOLS: ReadonlySet<string> = new Set(["get_trace", "get_session"]);

/**
 * Calls the model may still make after a cap refused one before the run is
 * stopped: enough to read the refusal and submit, not enough to spin on it.
 */
export const BLOCKED_CALLS_BEFORE_STOP = 5;

export interface LoopBudgetLimits {
  toolCalls: number;
  traceReads: number;
}

export const DEFAULT_LOOP_BUDGET: LoopBudgetLimits = {
  toolCalls: LOOP_LIMITS.toolCalls,
  traceReads: LOOP_LIMITS.traceReads,
};

/** What one run has spent and produced; read by the route once the turn ends. */
export interface LoopRunState {
  summary: string | null;
  /** Tool calls that ran (refused calls are not counted). */
  toolCalls: number;
  /** get_trace / get_session calls that ran. */
  tracesRead: number;
  /** A cap refused at least one call. */
  budgetExhausted: boolean;
  /** Calls refused: over a cap, or an empty summary. */
  blockedCalls: number;
}

export function newLoopRunState(): LoopRunState {
  return { summary: null, toolCalls: 0, tracesRead: 0, budgetExhausted: false, blockedCalls: 0 };
}

export function budgetBlockReason(what: string): string {
  return (
    `Budget reached: this run has used all ${what}. The call was not performed. ` +
    `Call ${SUBMIT_SUMMARY_TOOL} now with what you have found so far, and make no other calls.`
  );
}

/** Spend one call of `tool` from the run's budget, or say why it cannot run. */
function spend(state: LoopRunState, tool: string, limits: LoopBudgetLimits): string | null {
  if (tool === SUBMIT_SUMMARY_TOOL) {
    state.toolCalls += 1;
    return null;
  }
  if (state.toolCalls >= limits.toolCalls)
    return budgetBlockReason(`${limits.toolCalls} of its tool calls`);
  const isTraceRead = TRACE_READ_TOOLS.has(tool);
  if (isTraceRead && state.tracesRead >= limits.traceReads) {
    return budgetBlockReason(`${limits.traceReads} of its trace reads`);
  }
  if (isTraceRead) state.tracesRead += 1;
  state.toolCalls += 1;
  return null;
}

/**
 * Charge every call of `tool` to the run's tool-call and trace-read caps. A
 * call over a cap is not performed: its result tells the model to submit.
 * `onRunaway` fires once, when the model keeps calling past the cap, so the
 * caller can stop the run rather than pay for calls that cannot run.
 *
 * The count is taken before the first await, so calls the agent runs in
 * parallel cannot all pass the cap together.
 */
export function withBudget<T extends TSchema>(
  tool: AgentTool<T>,
  state: LoopRunState,
  onRunaway: () => void,
  limits: LoopBudgetLimits = DEFAULT_LOOP_BUDGET,
): AgentTool<T> {
  return {
    ...tool,
    execute: (...args: Parameters<AgentTool<T>["execute"]>) => {
      const refusal = spend(state, tool.name, limits);
      if (refusal === null) return tool.execute(...args);
      state.budgetExhausted = true;
      state.blockedCalls += 1;
      if (state.blockedCalls === BLOCKED_CALLS_BEFORE_STOP) onRunaway();
      return Promise.resolve({ content: [{ type: "text", text: refusal }], details: undefined });
    },
  };
}
