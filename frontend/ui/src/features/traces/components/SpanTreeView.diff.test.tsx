// @vitest-environment jsdom
// SpanTreeView in diff mode: the union of a trace and a baseline trace of the same case,
// in the tree's own row style. The virtualizer is mocked, as in the render test, since
// jsdom has no layout to measure.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, within } from "@testing-library/react";
import { SpanKind, SpanStatus } from "@traceroot/core";
import { traceUnion } from "@/lib/eval/union-tree";
import type { Span, TraceDetail } from "@/types/api";
import { SpanTreeView } from "./SpanTreeView";

vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getTotalSize: () => count * 28,
    getVirtualItems: () =>
      Array.from({ length: count }, (_, index) => ({ index, start: index * 28, size: 28 })),
    scrollToIndex: vi.fn(),
  }),
}));
vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({ prefetchQuery: vi.fn() }),
}));
vi.mock("@/lib/auth-client", () => ({ useSession: () => ({ data: undefined }) }));
vi.mock("@/lib/api", () => ({ getSpanIO: vi.fn() }));

const T0 = Date.UTC(2026, 10, 1, 10);
const at = (ms: number) => new Date(T0 + ms).toISOString();

type Row = [
  id: string,
  parent: string | null,
  name: string,
  kind: Span["span_kind"],
  start: number,
  end: number,
  extra?: Partial<Span>,
];

function traceOf(traceId: string, rows: Row[]): TraceDetail {
  const spans = rows.map(
    ([span_id, parent_span_id, name, span_kind, start, end, extra]): Span => ({
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
      ...extra,
    }),
  );
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
    spans,
  };
}

// The candidate plans with more tokens, answers instead of searching, and takes longer;
// both are judged by a scorer.
const BASELINE = traceOf("tb", [
  ["b0", null, "agent", SpanKind.AGENT, 0, 1000],
  ["b1", "b0", "plan", SpanKind.LLM, 10, 100, { total_tokens: 100 }],
  ["b2", "b0", "web_search", SpanKind.TOOL, 110, 200],
  ["b3", "b0", "faithfulness", SpanKind.SCORER, 300, 900],
  ["b4", "b3", "judge", SpanKind.LLM, 310, 890, { total_tokens: 500 }],
]);
const CANDIDATE = traceOf("tc", [
  ["c0", null, "agent", SpanKind.AGENT, 0, 1600],
  ["c1", "c0", "plan", SpanKind.LLM, 10, 100, { total_tokens: 150 }],
  ["c2", "c0", "answer", SpanKind.LLM, 110, 400],
  ["c3", "c0", "faithfulness", SpanKind.SCORER, 500, 1500],
  ["c4", "c3", "judge", SpanKind.LLM, 510, 1490, { total_tokens: 800 }],
]);
const NODES = traceUnion(BASELINE, CANDIDATE).nodes;

function renderTree(
  props: Partial<React.ComponentProps<typeof SpanTreeView>> = {},
  diff: Partial<NonNullable<React.ComponentProps<typeof SpanTreeView>["diff"]>> = {},
) {
  const onSelect = vi.fn();
  const onToggleCollapse = vi.fn();
  const utils = render(
    <SpanTreeView
      trace={CANDIDATE}
      selection={{ type: "trace" }}
      onSelect={onSelect}
      collapsedIds={new Set()}
      onToggleCollapse={onToggleCollapse}
      hoveredSpanId={null}
      onHoverChange={vi.fn()}
      scrollRef={{ current: null }}
      diff={{ baseline: BASELINE, nodes: NODES, measured: true, ...diff }}
      {...props}
    />,
  );
  const rows = () => [...utils.container.querySelectorAll<HTMLElement>("[data-diff-state]")];
  const row = (name: string) => rows().find((r) => r.textContent?.startsWith(name))!;
  return { ...utils, onSelect, onToggleCollapse, rows, row };
}

afterEach(() => cleanup());

describe("SpanTreeView in diff mode", () => {
  it("draws both traces as one tree, each span matched, added or removed", () => {
    const { rows } = renderTree();
    expect(
      rows().map((r) => [r.dataset.diffState, r.querySelector("[data-span-name]")!.textContent]),
    ).toEqual([
      ["matched", "agent"],
      ["matched", "plan"],
      ["removed", "web_search"],
      ["added", "answer"],
      ["matched", "faithfulness"],
      ["matched", "judge"],
    ]);
  });

  it("colours added names green and removed ones red, and mutes an evaluation's spans", () => {
    const { row } = renderTree();
    const name = (n: string) => row(n).querySelector("[data-span-name]")!.className;
    expect(name("answer")).toContain("text-success");
    expect(name("web_search")).toContain("text-destructive");
    expect(name("plan")).not.toMatch(/text-(success|destructive|muted)/);
    expect(name("faithfulness")).toContain("text-muted-foreground");
    expect(name("judge")).toContain("text-muted-foreground");
  });

  it("reads a matched span's duration and tokens before → after, coloured by direction", () => {
    const { row } = renderTree();
    const metric = (n: string, m: string) =>
      row(n).querySelector<HTMLElement>(`[data-metric="${m}"]`);
    expect(metric("agent", "duration")!.textContent).toBe("1.0s → 1.6s");
    expect(metric("agent", "duration")!.className).toContain("text-danger");
    expect(metric("plan", "tokens")!.textContent).toBe("100 → 150");
    expect(metric("plan", "tokens")!.className).toContain("text-danger");
    // A span one run alone has shows that run's figure.
    expect(metric("answer", "duration")!.textContent).toBe("290ms");
    expect(metric("web_search", "duration")!.textContent).toBe("90ms");
    // An evaluation's usage follows the output it judged: shown, never coloured.
    expect(metric("judge", "tokens")!.textContent).toBe("500 → 800");
    expect(metric("judge", "tokens")!.className).toContain("text-muted-foreground");
  });

  it("leaves the figures out when either trace is a reconstruction with none measured", () => {
    const { row } = renderTree({}, { measured: false });
    expect(row("agent").querySelector("[data-metric]")).toBeNull();
  });

  it("reads the trace row's totals before → after", () => {
    const { container } = renderTree();
    // The trace row is the first row, ahead of every span.
    const traceRow = container.querySelector<HTMLElement>('[style*="translateY(0px)"]')!;
    const figure = (m: string) => traceRow.querySelector(`[data-metric="${m}"]`)!.textContent;
    expect(figure("duration")).toBe("1.0s → 1.6s");
    expect(figure("tokens")).toBe("600 → 950");
  });

  it("selects a removed span by the baseline's span and any other by the candidate's", () => {
    const { row, onSelect } = renderTree();
    fireEvent.click(row("web_search"));
    fireEvent.click(row("answer"));
    fireEvent.click(row("plan"));
    expect(onSelect.mock.calls.map(([sel]) => [sel.span.trace_id, sel.span.span_id])).toEqual([
      ["tb", "b2"],
      ["tc", "c2"],
      ["tc", "c1"],
    ]);
  });

  it("marks the node selected", () => {
    const { row } = renderTree({
      selection: { type: "span", span: BASELINE.spans[2] },
    });
    expect(row("web_search").className).toContain("bg-accent");
    expect(row("answer").className).not.toContain("bg-accent");
  });

  it("collapses by node, hiding what is under it", () => {
    const { row, onToggleCollapse } = renderTree();
    fireEvent.click(within(row("faithfulness")).getByRole("button"));
    expect(onToggleCollapse).toHaveBeenCalledWith("baseline:b3");
    cleanup();

    const collapsed = renderTree({ collapsedIds: new Set(["baseline:b3"]) });
    expect(collapsed.rows().map((r) => r.querySelector("[data-span-name]")!.textContent)).toEqual([
      "agent",
      "plan",
      "web_search",
      "answer",
      "faithfulness",
    ]);
  });
});
