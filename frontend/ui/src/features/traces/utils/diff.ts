import type { UnionNode } from "@/lib/eval/union-tree";
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
