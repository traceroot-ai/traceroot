import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { TSchema } from "@earendil-works/pi-ai";
import { LOOP_LIMITS, type LoopFinding } from "@traceroot/core/loops/pure";

/** The tool that ends a run; it is never refused, so a run over budget can still report. */
export const SUBMIT_SUMMARY_TOOL = "loop_submit_summary";
/**
 * Records a finding the run already confirmed. The tool-call caps never refuse
 * it, so a run over budget can still hand over what it found; its own cap does.
 */
export const RECORD_FINDING_TOOL = "loop_record_finding";

/**
 * loop_record_finding calls a run may make per key it may record: room to fix
 * a refused call or add traces, not to spin on the tool.
 */
export const RECORD_CALLS_PER_KEY = 3;

/**
 * The record cap for a run that may add `newKeys` keys to the Loop's
 * `existingKeys`: a run records at most LOOP_LIMITS.findingsPerRun keys,
 * however many the Loop has.
 */
export function findingRecordCap(newKeys: number, existingKeys: number): number {
  return RECORD_CALLS_PER_KEY * Math.min(newKeys + existingKeys, LOOP_LIMITS.findingsPerRun);
}

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
  /** loop_record_finding calls (see findingRecordCap). */
  findingRecords: number;
}

/** What one run has spent and produced; read by the route once the turn ends. */
export interface LoopRunState {
  summary: string | null;
  /** Findings by key, in the order first recorded. */
  findings: Map<string, LoopFinding>;
  /** Trace ids get_trace and get_session returned this run: a finding may cite only these. */
  readTraceIds: Set<string>;
  /** Tool calls that ran (refused calls are not counted). */
  toolCalls: number;
  /** get_trace / get_session calls that ran. */
  tracesRead: number;
  /** loop_record_finding calls that ran. */
  findingRecords: number;
  /** A cap refused at least one call. */
  budgetExhausted: boolean;
  /** Calls refused by a cap. */
  blockedCalls: number;
}

export function newLoopRunState(): LoopRunState {
  return {
    summary: null,
    findings: new Map(),
    readTraceIds: new Set(),
    toolCalls: 0,
    tracesRead: 0,
    findingRecords: 0,
    budgetExhausted: false,
    blockedCalls: 0,
  };
}

export function budgetBlockReason(what: string): string {
  return (
    `Budget reached: this run has used all ${what}. The call was not performed. ` +
    `Record any finding you already confirmed with ${RECORD_FINDING_TOOL}, then call ` +
    `${SUBMIT_SUMMARY_TOOL} with what you have found so far, and make no other calls.`
  );
}

export function findingRecordBlockReason(cap: number): string {
  return (
    `Not performed: this run has used all ${cap} of its ${RECORD_FINDING_TOOL} calls. ` +
    `Call ${SUBMIT_SUMMARY_TOOL} now, and make no other calls.`
  );
}

/** Spend one call of `tool` from the run's budget, or say why it cannot run. */
function spend(state: LoopRunState, tool: string, limits: LoopBudgetLimits): string | null {
  if (tool === SUBMIT_SUMMARY_TOOL) {
    state.toolCalls += 1;
    return null;
  }
  // Counted on its own cap, not the tool-call one, so an exhausted run can still record.
  if (tool === RECORD_FINDING_TOOL) {
    if (state.findingRecords >= limits.findingRecords) {
      return findingRecordBlockReason(limits.findingRecords);
    }
    state.findingRecords += 1;
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
 * Charge every call of `tool` to the run's tool-call, trace-read and
 * finding-record caps (spend). A call over a cap is not performed: its result tells the model to submit.
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
  limits: LoopBudgetLimits,
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
