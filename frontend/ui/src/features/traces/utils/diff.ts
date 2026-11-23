import type { MetricPair, UnionNode } from "@/lib/eval/union-tree";
import type { Span, TraceDetail } from "@/types/api";
import { getSpanDuration, getTraceDuration, parseTimestamp } from "./index";

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
  const onBaseline = (n: UnionNode) => n.baseline?.span_id === span.span_id;
  const onCandidate = (n: UnionNode) => n.candidate?.span_id === span.span_id;
  const found =
    baselineTraceId !== null && span.trace_id === baselineTraceId
      ? nodes.find(onBaseline)
      : nodes.find(onCandidate);
  return found ?? null;
}

/** The text colour of a figure that moved in diff mode: green when it got better (lower,
 *  for every figure the viewer compares), red when worse, muted when it didn't move enough
 *  to count or can't be compared. */
export function moveClass(move: "better" | "worse" | null): string {
  return move === "better"
    ? "text-success"
    : move === "worse"
      ? "text-danger"
      : "text-muted-foreground";
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
