// @vitest-environment jsdom
// SpanTimelineView in diff mode: this trace's bars as usual over the union's rows, with the
// baseline's span drawn as a ghost behind a matched bar and alone for a span only the
// baseline has. Same mocks as the timeline's render test.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { SpanKind, SpanStatus } from "@traceroot/core";
import { traceUnion, visibleUnionNodes } from "@/lib/eval/union-tree";
import type { Span, TraceDetail } from "@/types/api";
import { SpanTimelineView } from "./SpanTimelineView";

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(global as unknown as { ResizeObserver: typeof ResizeObserverStub }).ResizeObserver =
  ResizeObserverStub;

vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getTotalSize: () => count * 28,
    getVirtualItems: () =>
      Array.from({ length: count }, (_, index) => ({ index, start: index * 28, size: 28 })),
  }),
}));

const T0 = Date.UTC(2026, 10, 1, 10);
const at = (ms: number) => new Date(T0 + ms).toISOString();

type Row = [
  id: string,
  parent: string | null,
  name: string,
  kind: Span["span_kind"],
  start: number,
  end: number,
];

function traceOf(traceId: string, rows: Row[]): TraceDetail {
  return {
    trace_id: traceId,
    project_id: "p1",
    name: "agent",
    trace_start_time: at(0),
    user_id: null,
    session_id: null,
    git_ref: null,
    git_repo: null,
    environment: "production",
    release: null,
    input: null,
    output: null,
    metadata: null,
    spans: rows.map(([span_id, parent_span_id, name, span_kind, start, end]) => ({
      span_id,
      trace_id: traceId,
      parent_span_id,
      name,
      span_kind,
      span_start_time: at(start),
      span_end_time: at(end),
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
    })),
  };
}

// The candidate runs 1600ms to the baseline's 1000ms: the timeline spans 1600ms over the
// default 800px, so 1ms is half a pixel.
const BASELINE = traceOf("tb", [
  ["b0", null, "agent", SpanKind.AGENT, 0, 1000],
  ["b1", "b0", "plan", SpanKind.LLM, 0, 200],
  ["b2", "b0", "web_search", SpanKind.TOOL, 400, 600],
]);
const CANDIDATE = traceOf("tc", [
  ["c0", null, "agent", SpanKind.AGENT, 0, 1600],
  ["c1", "c0", "plan", SpanKind.LLM, 0, 400],
  ["c2", "c0", "answer", SpanKind.LLM, 800, 1200],
]);
const NODES = traceUnion(BASELINE, CANDIDATE).nodes;

function renderTimeline(props: Partial<React.ComponentProps<typeof SpanTimelineView>> = {}) {
  const onSelect = vi.fn();
  const utils = render(
    <SpanTimelineView
      trace={CANDIDATE}
      selection={{ type: "trace" }}
      onSelect={onSelect}
      collapsedIds={new Set()}
      scrollRef={{ current: null }}
      hoveredSpanId={null}
      onHoverChange={vi.fn()}
      diff={{ baseline: BASELINE, nodes: NODES }}
      {...props}
    />,
  );
  const rows = () => [...utils.container.querySelectorAll<HTMLElement>("[data-diff-state]")];
  const row = (i: number) => rows()[i];
  const bar = (el: HTMLElement, kind: "bar" | "ghost") =>
    el.querySelector<HTMLElement>(`[data-diff-${kind}]`);
  return { ...utils, onSelect, rows, row, bar };
}

afterEach(() => cleanup());

describe("SpanTimelineView in diff mode", () => {
  it("lays out the same rows as the tree, in its order", () => {
    const { rows } = renderTimeline();
    expect(rows().map((r) => r.dataset.diffState)).toEqual(
      visibleUnionNodes(NODES, new Set()).map((n) => n.state),
    );
    expect(rows().map((r) => r.dataset.diffState)).toEqual([
      "matched",
      "matched",
      "removed",
      "added",
    ]);
  });

  it("draws the baseline's span as a ghost behind a matched bar", () => {
    const { row, bar } = renderTimeline();
    const plan = row(1);
    expect(bar(plan, "bar")!.style.width).toBe("200px");
    expect(bar(plan, "ghost")!.style.width).toBe("100px");
    expect(bar(plan, "ghost")!.getAttribute("title")).toBe("Baseline: 200ms");
  });

  it("draws a span only the baseline has as a ghost alone, and one only this trace has as a bar alone", () => {
    const { row, bar } = renderTimeline();
    const search = row(2);
    expect(bar(search, "bar")).toBeNull();
    expect(bar(search, "ghost")!.style.left).toBe("200px");
    const answer = row(3);
    expect(bar(answer, "ghost")).toBeNull();
    expect(bar(answer, "bar")!.style.left).toBe("400px");
  });

  it("scales the trace row to both runs, the baseline's length a ghost behind it", () => {
    const { container } = renderTimeline();
    const traceRow = container.querySelector<HTMLElement>('[style*="translateY(0px)"]')!;
    expect(traceRow.querySelector<HTMLElement>("[data-diff-ghost]")!.style.width).toBe("62.5%");
  });

  it("selects a span only the baseline has by the baseline's span", () => {
    const { row, onSelect } = renderTimeline();
    fireEvent.click(row(2));
    expect(onSelect).toHaveBeenCalledWith({
      type: "span",
      span: expect.objectContaining({ span_id: "b2", trace_id: "tb" }),
    });
  });
});
