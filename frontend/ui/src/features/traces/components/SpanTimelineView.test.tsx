// @vitest-environment jsdom
import { afterEach, describe, it, expect, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { SpanKind, SpanStatus } from "@traceroot/core";
import type { TraceDetail } from "@/types/api";
import type { TraceSelection } from "../types";
import { SpanTimelineView } from "./SpanTimelineView";

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
// jsdom doesn't implement ResizeObserver, which this component uses to track
// the timeline's width for tick spacing.
(global as unknown as { ResizeObserver: typeof ResizeObserverStub }).ResizeObserver =
  ResizeObserverStub;

vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getTotalSize: () => count * 28,
    getVirtualItems: () =>
      Array.from({ length: count }, (_, index) => ({ index, start: index * 28, size: 28 })),
  }),
}));

const trace: TraceDetail = {
  trace_id: "trace-1",
  project_id: "proj-1",
  name: "root-trace",
  trace_start_time: "2026-01-01T00:00:00.000Z",
  user_id: null,
  session_id: null,
  git_ref: null,
  git_repo: null,
  environment: "production",
  release: null,
  input: null,
  output: null,
  metadata: null,
  spans: [
    {
      span_id: "span-1",
      trace_id: "trace-1",
      parent_span_id: null,
      name: "llm-call",
      span_kind: SpanKind.LLM,
      span_start_time: "2026-01-01T00:00:00.000Z",
      span_end_time: "2026-01-01T00:00:01.000Z",
      status: SpanStatus.OK,
      status_message: null,
      model_name: "gpt-4o",
      cost: 0.0123,
      input_tokens: 100,
      output_tokens: 50,
      total_tokens: 150,
      git_source_file: null,
      git_source_line: null,
      git_source_function: null,
    },
  ],
};

const selection: TraceSelection = { type: "trace" };

// vitest runs without `globals`, so testing-library's automatic cleanup is
// inactive and a second render would stack onto the first one's DOM.
afterEach(() => {
  cleanup();
});

function renderTimeline() {
  return render(
    <SpanTimelineView
      trace={trace}
      selection={selection}
      onSelect={vi.fn()}
      collapsedIds={new Set()}
      scrollRef={{ current: null }}
      hoveredSpanId={null}
      onHoverChange={vi.fn()}
    />,
  );
}

describe("SpanTimelineView token/cost badges", () => {
  it("renders the trace-root and per-span token/cost badges", () => {
    renderTimeline();

    // Cost renders twice: the trace-root rollup and the one LLM span's own —
    // both format to "0.0123" here since there's only a single span.
    expect(screen.getAllByText("0.0123").length).toBe(2);
  });

  it("draws a glyph alongside each token and cost badge", () => {
    renderTimeline();

    // The badge text nodes are wrapped in a span that also holds the icon, so
    // a missing glyph shows up as a badge with no svg child.
    for (const badge of screen.getAllByText("0.0123")) {
      expect(badge.querySelector("svg")).toBeTruthy();
    }
    for (const badge of screen.getAllByText("100 → 50 (150)")) {
      expect(badge.querySelector("svg")).toBeTruthy();
    }
  });
});
