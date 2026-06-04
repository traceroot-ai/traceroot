import { describe, it, expect } from "vitest";
import { SpanKind, SpanStatus } from "@traceroot/core";
import type { Span } from "@/types/api";
import type { SpanTreeRow } from "../types";
import { buildSpanTree } from "../utils";
import { getVisibleSpanRows } from "./SpanTreeView";

// Minimal span factory — only fields relevant to the tree row model.
function makeSpan(overrides: Partial<Span> & { span_id: string }): Span {
  return {
    trace_id: "trace-1",
    parent_span_id: null,
    name: overrides.span_id,
    span_kind: SpanKind.SPAN,
    span_start_time: "2024-01-01T00:00:00.000Z",
    span_end_time: "2024-01-01T00:00:01.000Z",
    status: SpanStatus.OK,
    status_message: null,
    model_name: null,
    cost: null,
    input_tokens: null,
    output_tokens: null,
    total_tokens: null,
    input: null,
    output: null,
    metadata: null,
    git_source_file: null,
    git_source_line: null,
    git_source_function: null,
    ...overrides,
  };
}

// root → a → a1, a2 ; root → b
function makeTree(): { spans: Span[]; spanById: Map<string, Span>; rows: SpanTreeRow[] } {
  const spans = [
    makeSpan({ span_id: "root" }),
    makeSpan({ span_id: "a", parent_span_id: "root", span_start_time: "2024-01-01T00:00:00.100Z" }),
    makeSpan({ span_id: "a1", parent_span_id: "a", span_start_time: "2024-01-01T00:00:00.200Z" }),
    makeSpan({ span_id: "a2", parent_span_id: "a", span_start_time: "2024-01-01T00:00:00.300Z" }),
    makeSpan({ span_id: "b", parent_span_id: "root", span_start_time: "2024-01-01T00:00:00.400Z" }),
  ];
  const spanById = new Map(spans.map((s) => [s.span_id, s]));
  return { spans, spanById, rows: buildSpanTree(spans) };
}

describe("getVisibleSpanRows", () => {
  it("returns all rows when nothing is collapsed", () => {
    const { spanById, rows } = makeTree();
    const visible = getVisibleSpanRows(rows, spanById, new Set());
    expect(visible.map((r) => r.span.span_id)).toEqual(["root", "a", "a1", "a2", "b"]);
  });

  it("returns the same array reference when no ids are collapsed (fast path)", () => {
    const { spanById, rows } = makeTree();
    expect(getVisibleSpanRows(rows, spanById, new Set())).toBe(rows);
  });

  it("hides descendants of a collapsed span but keeps the collapsed span itself", () => {
    const { spanById, rows } = makeTree();
    const visible = getVisibleSpanRows(rows, spanById, new Set(["a"]));
    expect(visible.map((r) => r.span.span_id)).toEqual(["root", "a", "b"]);
  });

  it("hides an entire deep subtree when an ancestor is collapsed", () => {
    const { spanById, rows } = makeTree();
    const visible = getVisibleSpanRows(rows, spanById, new Set(["root"]));
    expect(visible.map((r) => r.span.span_id)).toEqual(["root"]);
  });

  it("preserves linearized DFS order of the remaining rows", () => {
    const { spanById, rows } = makeTree();
    const visible = getVisibleSpanRows(rows, spanById, new Set());
    // a1 must precede a2, and a's subtree must precede sibling b
    const ids = visible.map((r) => r.span.span_id);
    expect(ids.indexOf("a1")).toBeLessThan(ids.indexOf("a2"));
    expect(ids.indexOf("a2")).toBeLessThan(ids.indexOf("b"));
  });
});
