import { describe, expect, it } from "vitest";
import { SpanKind, SpanStatus } from "@traceroot/core";
import { buildUnionTree } from "@/lib/eval/union-tree";
import type { Span } from "@/types/api";
import { beforeAfter, findUnionNode, moveClass } from "./diff";

const span = (traceId: string, id: string, parent: string | null, name: string): Span => ({
  span_id: id,
  trace_id: traceId,
  parent_span_id: parent,
  name,
  span_kind: SpanKind.SPAN,
  span_start_time: "2026-11-01T10:00:00.000Z",
  span_end_time: "2026-11-01T10:00:01.000Z",
  status: SpanStatus.OK,
  status_message: null,
  error_type: "",
  model_name: null,
  cost: null,
  input_tokens: null,
  output_tokens: null,
  total_tokens: null,
  git_source_file: null,
  git_source_line: null,
  git_source_function: null,
});

describe("findUnionNode", () => {
  // Both traces reuse the same span ids, as two runs replaying one recording can.
  const baseline = [span("tb", "root", null, "agent"), span("tb", "s1", "root", "search")];
  const candidate = [span("tc", "root", null, "agent"), span("tc", "s1", "root", "answer")];
  const { nodes } = buildUnionTree(baseline, candidate);

  it("finds a candidate span's node by its candidate id", () => {
    expect(findUnionNode(nodes, candidate[1], "tb")?.id).toBe("candidate:s1");
    expect(findUnionNode(nodes, candidate[0], "tb")?.id).toBe("baseline:root");
  });

  it("finds a span only the baseline has by its baseline id", () => {
    expect(findUnionNode(nodes, baseline[1], "tb")?.id).toBe("baseline:s1");
  });

  it("finds nothing for a span neither trace has", () => {
    expect(findUnionNode(nodes, span("tc", "gone", null, "x"), "tb")).toBeNull();
    expect(findUnionNode(nodes, span("other", "s1", null, "x"), "tb")?.id).toBe("candidate:s1");
  });
});

describe("beforeAfter and moveClass", () => {
  it("reads a figure on the baseline, then on this trace, dashing a side with none", () => {
    const ms = (n: number) => `${n}ms`;
    expect(beforeAfter({ baseline: 100, candidate: 80 }, ms)).toBe("100ms → 80ms");
    expect(beforeAfter({ baseline: null, candidate: 80 }, ms)).toBe("— → 80ms");
  });

  it("colours better green, worse red and anything else muted", () => {
    expect(moveClass("better")).toBe("text-success");
    expect(moveClass("worse")).toBe("text-danger");
    expect(moveClass(null)).toBe("text-muted-foreground");
  });
});
