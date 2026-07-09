import { describe, it, expect } from "vitest";
import { SpanKind, SpanStatus } from "@traceroot/core";
import type { Span } from "@/types/api";
import { flattenTreeWithMetrics } from "./timeline";

// Minimal span factory — only fields relevant to timeline metrics.
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

describe("flattenTreeWithMetrics pixel metrics", () => {
  it("computes offsets and widths from span times against the trace window", () => {
    const spans = [
      makeSpan({
        span_id: "root",
        span_start_time: "2024-01-01T00:00:00.000Z",
        span_end_time: "2024-01-01T00:00:01.000Z",
      }),
      makeSpan({
        span_id: "child",
        parent_span_id: "root",
        span_start_time: "2024-01-01T00:00:00.100Z",
        span_end_time: "2024-01-01T00:00:00.400Z",
      }),
    ];
    const items = flattenTreeWithMetrics(spans, new Set(), 1000, 800);
    expect(items.map((i) => i.span.span_id)).toEqual(["root", "child"]);

    const [rootMetrics, childMetrics] = items.map((i) => i.metrics);
    expect(rootMetrics.startOffsetPx).toBe(0);
    expect(rootMetrics.widthPx).toBe(800);
    expect(rootMetrics.durationMs).toBe(1000);
    expect(rootMetrics.isInProgress).toBe(false);
    expect(rootMetrics.isInstant).toBe(false);
    expect(childMetrics.startOffsetPx).toBeCloseTo(80, 5);
    expect(childMetrics.widthPx).toBeCloseTo(240, 5);
    expect(childMetrics.durationMs).toBe(300);
  });

  it("marks sub-2px closed spans instant and open spans in-progress", () => {
    const spans = [
      makeSpan({
        span_id: "tiny",
        span_start_time: "2024-01-01T00:00:00.000Z",
        span_end_time: "2024-01-01T00:00:00.001Z",
      }),
      makeSpan({
        span_id: "open",
        span_start_time: "2024-01-01T00:00:00.000Z",
        span_end_time: null,
      }),
    ];
    const items = flattenTreeWithMetrics(spans, new Set(), 100_000, 800);
    const tiny = items.find((i) => i.span.span_id === "tiny")!.metrics;
    const open = items.find((i) => i.span.span_id === "open")!.metrics;
    expect(tiny.isInstant).toBe(true);
    expect(open.isInProgress).toBe(true);
    expect(open.isInstant).toBe(false);
  });

  it("keeps a collapsed span visible but drops its descendants", () => {
    const spans = [
      makeSpan({ span_id: "root" }),
      makeSpan({
        span_id: "a",
        parent_span_id: "root",
        span_start_time: "2024-01-01T00:00:00.100Z",
      }),
      makeSpan({
        span_id: "a1",
        parent_span_id: "a",
        span_start_time: "2024-01-01T00:00:00.200Z",
      }),
    ];
    const items = flattenTreeWithMetrics(spans, new Set(["a"]), 1000, 800);
    expect(items.map((i) => i.span.span_id)).toEqual(["root", "a"]);
  });
});
