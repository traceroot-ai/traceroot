import type {
  MetricPair,
  UnionNode,
  UnionNodeMetrics,
  UnionNodeState,
} from "@/lib/eval/union-tree";
import type { Span, TraceDetail } from "@/types/api";
import type { TraceSelection } from "../types";
import {
  getSpanDuration,
  getTraceDuration,
  getTraceTokenUsage,
  getTraceTotalCost,
  parseTimestamp,
} from "./index";

/**
 * The node of the union of two traces a selected span stands for. In diff mode the tree
 * selects a span only the baseline has by the baseline's span, and any other node by the
 * candidate's, so the trace a span belongs to says which side to look it up on. Null for
 * a span neither trace has.
 */
export function findUnionNode(
  nodes: readonly UnionNode[],
  span: Pick<Span, "span_id" | "trace_id">,
  baselineTraceId: string | null,
): UnionNode | null {
  const side =
    baselineTraceId !== null && span.trace_id === baselineTraceId ? "baseline" : "candidate";
  return nodes.find((n) => n[side]?.span_id === span.span_id) ?? null;
}

/** The text colour of a figure that moved in diff mode: green when it got better (lower,
 *  for every figure the viewer compares), red when worse, muted when it didn't move enough
 *  to count or can't be compared. */
export function moveClass(move: "better" | "worse" | null): string {
  switch (move) {
    case "better":
      return "text-success";
    case "worse":
      return "text-danger";
    default:
      return "text-muted-foreground";
  }
}

/** The text colour of a node's name by state: green when only this trace has the span, red
 *  when only the baseline does. */
export const UNION_STATE_CLASS: Record<UnionNodeState, string> = {
  matched: "",
  added: "text-success",
  removed: "text-destructive",
};

/** Whether the selection is this span of this trace. By trace as well as id: the two
 *  traces' span ids can coincide. */
export function isSpanSelected(selection: TraceSelection, span: Span): boolean {
  return (
    selection.type === "span" &&
    selection.span.span_id === span.span_id &&
    selection.span.trace_id === span.trace_id
  );
}

/** A whole trace's figures on each side of the diff; the baseline's are null when there is
 *  no baseline trace. */
export function traceFigures(baseline: TraceDetail | null, trace: TraceDetail): UnionNodeMetrics {
  return {
    durationMs: {
      baseline: baseline && getTraceDuration(baseline),
      candidate: getTraceDuration(trace),
    },
    totalTokens: {
      baseline: (baseline && getTraceTokenUsage(baseline)?.totalTokens) ?? null,
      candidate: getTraceTokenUsage(trace)?.totalTokens ?? null,
    },
    cost: {
      baseline: baseline && getTraceTotalCost(baseline),
      candidate: getTraceTotalCost(trace),
    },
  };
}

/** "1.0s → 1.6s": a figure on the baseline, then on this trace; "—" for a side with none. */
export function beforeAfter(pair: MetricPair, format: (n: number) => string): string {
  const show = (n: number | null) => (n === null ? "—" : format(n));
  return `${show(pair.baseline)} → ${show(pair.candidate)}`;
}

/** Where a span's bar sits on the timeline, from the start of its own trace. */
export interface DiffBar {
  offsetMs: number;
  durationMs: number;
  inProgress: boolean;
}

/**
 * Each node's bars on the diff timeline, by node id: this trace's span as the bar and the
 * baseline's as the ghost behind it, either absent on a span only one run has. Each run is
 * measured from its own earliest span, as the plain timeline measures a trace, so the two
 * line up from their starts.
 */
export function unionBars(
  nodes: readonly UnionNode[],
): Map<string, { bar: DiffBar | null; ghost: DiffBar | null }> {
  const startOf = (spans: (Span | null)[]) =>
    Math.min(...spans.flatMap((s) => (s ? [parseTimestamp(s.span_start_time)] : [])));
  const candidateStart = startOf(nodes.map((n) => n.candidate));
  const baselineStart = startOf(nodes.map((n) => n.baseline));
  const barOf = (span: Span | null, start: number): DiffBar | null =>
    span && {
      offsetMs: parseTimestamp(span.span_start_time) - start,
      durationMs: getSpanDuration(span) ?? 0,
      // A placeholder has no end because it never arrived, not because it is running.
      inProgress: span.span_end_time === null && !span.pending,
    };
  return new Map(
    nodes.map((n) => [
      n.id,
      { bar: barOf(n.candidate, candidateStart), ghost: barOf(n.baseline, baselineStart) },
    ]),
  );
}

/** The span the diff timeline covers: the longer of the two runs, so neither runs off it. */
export function diffScaleMs(trace: TraceDetail, baseline: TraceDetail): number {
  return Math.max(1, getTraceDuration(trace) ?? 1, getTraceDuration(baseline) ?? 1);
}
