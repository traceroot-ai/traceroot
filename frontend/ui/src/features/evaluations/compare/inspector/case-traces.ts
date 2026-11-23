import type { TraceDetail } from "@/types/api";
import { buildEvalTrace } from "../../eval-trace";
import type { ResultRow, RunDetail } from "../../types";

/** What one run of the pair has to show as its trace of the case. */
export type CaseTrace =
  /** The run has no result for the case. */
  | { kind: "no_result" }
  /** The result reported no trace: rebuilt from the result itself, as run detail does. */
  | { kind: "reconstructed"; trace: TraceDetail }
  /** The result reported a trace that hasn't been ingested yet: its fetch fails before it
   *  ever loads. */
  | { kind: "pending"; traceId: string }
  /** The result's own trace, still loading (`trace` undefined) or loaded. */
  | { kind: "reported"; traceId: string; trace: TraceDetail | undefined };

/** One run's trace of the case, from its result and the state of that trace's fetch. */
export function caseTrace(
  result: ResultRow | undefined,
  run: RunDetail,
  fetched: { data?: TraceDetail; isError: boolean },
): CaseTrace {
  if (!result) return { kind: "no_result" };
  if (!result.traceId) return { kind: "reconstructed", trace: buildEvalTrace(result, run) };
  if (fetched.isError && !fetched.data) return { kind: "pending", traceId: result.traceId };
  return { kind: "reported", traceId: result.traceId, trace: fetched.data };
}
