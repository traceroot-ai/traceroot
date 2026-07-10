// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createRef } from "react";
import { SpanKind, SpanStatus } from "@traceroot/core";
import type { Span, TraceDetail } from "@/types/api";

// Render every row: the real virtualizer measures a zero-height scroll
// element under jsdom and would mount nothing.
vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getTotalSize: () => count * 28,
    getVirtualItems: () =>
      Array.from({ length: count }, (_, index) => ({ index, start: index * 28, size: 28 })),
    scrollToIndex: vi.fn(),
  }),
}));

import { SpanTimelineView } from "./SpanTimelineView";

// Minimal span factory — only fields the timeline reads.
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

function makeTrace(spans: Span[]): TraceDetail {
  return { trace_id: "t1", project_id: "p1", name: "demo", spans } as unknown as TraceDetail;
}

const baseSpans = [
  makeSpan({
    span_id: "root",
    span_start_time: "2024-01-01T00:00:00.000Z",
    span_end_time: "2024-01-01T00:00:10.000Z",
  }),
  makeSpan({
    span_id: "llm",
    parent_span_id: "root",
    span_kind: SpanKind.LLM,
    span_start_time: "2024-01-01T00:00:01.000Z",
    span_end_time: "2024-01-01T00:00:05.000Z",
    input_tokens: 1000,
    output_tokens: 500,
    total_tokens: 1500,
    cost: 0.0123,
  }),
  makeSpan({
    span_id: "tool",
    parent_span_id: "root",
    span_kind: SpanKind.TOOL,
    span_start_time: "2024-01-01T00:00:05.000Z",
    span_end_time: "2024-01-01T00:00:05.001Z",
  }),
  makeSpan({
    span_id: "bad",
    parent_span_id: "root",
    status: SpanStatus.ERROR,
    span_start_time: "2024-01-01T00:00:06.000Z",
    span_end_time: "2024-01-01T00:00:07.000Z",
  }),
];

function renderTimeline(overrides: Partial<Parameters<typeof SpanTimelineView>[0]> = {}) {
  const onSelect = vi.fn();
  const onHoverChange = vi.fn();
  const utils = render(
    <SpanTimelineView
      trace={makeTrace(baseSpans)}
      selection={{ type: "trace" }}
      onSelect={onSelect}
      collapsedIds={new Set()}
      scrollRef={createRef<HTMLDivElement>()}
      hoveredSpanId={null}
      onHoverChange={onHoverChange}
      {...overrides}
    />,
  );
  return { onSelect, onHoverChange, ...utils };
}

beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("SpanTimelineView rendering", () => {
  it("renders the ruler, the trace-root bar, and one bar row per span", () => {
    renderTimeline();
    // Ruler ticks (10s window → 0..10s in 1s or 2s steps; "0" always present)
    expect(screen.getByText("0")).toBeTruthy();
    // Trace-root row duration + root span row duration
    expect(screen.getAllByText("10.0s").length).toBeGreaterThanOrEqual(2);
    // LLM row metrics
    expect(screen.getByText("4.0s")).toBeTruthy();
    expect(screen.getAllByText(/1\.5K/).length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("0.0123").length).toBeGreaterThanOrEqual(1);
    // Tool row duration
    expect(screen.getByText("1ms")).toBeTruthy();
  });

  it("styles error spans with the error bar treatment", () => {
    const { container } = renderTimeline();
    expect(container.querySelector(".border-red-300")).toBeTruthy();
  });

  it("marks in-progress spans with the pulsing bar treatment", () => {
    const spans = [
      baseSpans[0],
      makeSpan({
        span_id: "open",
        parent_span_id: "root",
        span_start_time: "2024-01-01T00:00:02.000Z",
        span_end_time: null,
      }),
    ];
    const { container } = renderTimeline({ trace: makeTrace(spans) });
    expect(container.querySelector(".animate-pulse")).toBeTruthy();
  });

  it("selects a span on row click and reports hover changes", () => {
    const { onSelect, onHoverChange } = renderTimeline();
    const llmRow = screen.getByText("4.0s").closest("div.group")!;
    fireEvent.mouseEnter(llmRow);
    expect(onHoverChange).toHaveBeenCalledWith("llm");
    fireEvent.mouseLeave(llmRow);
    expect(onHoverChange).toHaveBeenCalledWith(null);
    fireEvent.click(llmRow);
    expect(onSelect).toHaveBeenCalledWith({ type: "span", span: baseSpans[1] });
  });

  it("selects the trace from the trace-root row", () => {
    const { onSelect, onHoverChange, container } = renderTimeline();
    const rootRow = container.querySelector("div.hover\\:bg-muted\\/50")!;
    fireEvent.mouseEnter(rootRow);
    expect(onHoverChange).toHaveBeenCalledWith("trace");
    fireEvent.click(rootRow);
    expect(onSelect).toHaveBeenCalledWith({ type: "trace" });
  });

  it("renders only the trace-root row when the trace is collapsed", () => {
    renderTimeline({ collapsedIds: new Set(["trace"]) });
    expect(screen.queryByText("4.0s")).toBeNull();
    expect(screen.getAllByText("10.0s").length).toBe(1); // trace-root bar only
  });
});
