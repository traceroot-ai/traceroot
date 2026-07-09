import { describe, it, expect } from "vitest";
import { SpanKind, SpanStatus } from "@traceroot/core";
import type { Span } from "@/types/api";
import type { SpanTreeRow } from "../types";
import { buildSpanTree } from "../utils";
import { flattenTreeWithMetrics } from "../utils/timeline";
import { getVisibleSpanRows, buildTreeRows } from "./SpanTreeView";

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

// Maps the virtualized row model to a flat id list ("trace" for the root row)
// so index assertions read clearly.
const rowIds = (treeRows: ReturnType<typeof buildTreeRows>) =>
  treeRows.map((r) => (r.type === "trace" ? "trace" : r.row.span.span_id));

describe("buildTreeRows", () => {
  it("places the trace root at index 0, with spans following in DFS order", () => {
    const { spanById, rows } = makeTree();
    const treeRows = buildTreeRows(rows, spanById, new Set());
    expect(treeRows[0]).toEqual({ type: "trace" });
    expect(rowIds(treeRows)).toEqual(["trace", "root", "a", "a1", "a2", "b"]);
  });

  it("drops descendants of a collapsed span", () => {
    const { spanById, rows } = makeTree();
    expect(rowIds(buildTreeRows(rows, spanById, new Set(["a"])))).toEqual([
      "trace",
      "root",
      "a",
      "b",
    ]);
  });

  it("yields only the trace row when the trace root is collapsed", () => {
    const { spanById, rows } = makeTree();
    expect(buildTreeRows(rows, spanById, new Set(["trace"]))).toEqual([{ type: "trace" }]);
  });

  it("locates a span's virtualizer index past the trace-root offset", () => {
    const { spanById, rows } = makeTree();
    const treeRows = buildTreeRows(rows, spanById, new Set());
    // scrollToSpan uses exactly this findIndex; "a" sits at [trace, root, a, ...]
    const index = treeRows.findIndex((r) => r.type === "span" && r.row.span.span_id === "a");
    expect(index).toBe(2);
  });

  it("returns -1 for a span hidden under a collapsed ancestor", () => {
    const { spanById, rows } = makeTree();
    const treeRows = buildTreeRows(rows, spanById, new Set(["a"]));
    const index = treeRows.findIndex((r) => r.type === "span" && r.row.span.span_id === "a1");
    expect(index).toBe(-1);
  });
});

// The tree (buildTreeRows) and the timeline (flattenTreeWithMetrics) flatten the
// same spans through two independent code paths but are rendered scroll-synced,
// row-for-row. If their visible-span ORDER ever diverges the panels misalign
// silently. This locks the invariant so a regression is a CI failure, not a
// visual bug. (Trace-root collapse is handled per-panel, not in the flatteners,
// so it is intentionally excluded here.)
describe("buildTreeRows ↔ flattenTreeWithMetrics ordering parity", () => {
  const visibleSpanIds = (collapsed: Set<string>) => {
    const { spans, spanById, rows } = makeTree();
    const treeIds = buildTreeRows(rows, spanById, collapsed).flatMap((r) =>
      r.type === "span" ? [r.row.span.span_id] : [],
    );
    const timelineIds = flattenTreeWithMetrics(spans, collapsed, 1000, 800).map(
      (item) => item.span.span_id,
    );
    return { treeIds, timelineIds };
  };

  it("agree on visible span order with nothing collapsed", () => {
    const { treeIds, timelineIds } = visibleSpanIds(new Set());
    expect(treeIds).toEqual(timelineIds);
    expect(treeIds).toEqual(["root", "a", "a1", "a2", "b"]);
  });

  it("agree on visible span order when a subtree is collapsed", () => {
    const { treeIds, timelineIds } = visibleSpanIds(new Set(["a"]));
    expect(treeIds).toEqual(timelineIds);
    expect(treeIds).toEqual(["root", "a", "b"]);
  });
});

describe("buildSpanTree caching", () => {
  it("returns the identical rows array for the same spans array", () => {
    const { spans } = makeTree();
    expect(buildSpanTree(spans)).toBe(buildSpanTree(spans));
  });
});
