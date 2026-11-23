import type { MetricPair, UnionNode } from "@/lib/eval/union-tree";
import type { Span } from "@/types/api";

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
