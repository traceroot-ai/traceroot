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
import { DivergenceChip } from "./TraceDiffControls";

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

describe("SpanTreeView in diff mode on a retried call", () => {
  // The candidate's `agent` span was never exported: its children name it as their parent
  // and carry it in their recorded path, so it is drawn as a placeholder. Its first search
  // failed and was retried, and its answer used more tokens.
  const under = (name: string): Partial<Span> => ({
    metadata: JSON.stringify({
      "traceroot.span.ids_path": ["c-eval", "c-task", "c-agent"],
      "traceroot.span.path": ["evaluation-item", "task", "agent", name],
    }),
  });
  const RUN_1 = traceOf("t1", [
    ["b-eval", null, "evaluation-item", SpanKind.EVALUATION, 0, 3000],
    ["b-task", "b-eval", "task", SpanKind.TASK, 10, 2000],
    ["b-agent", "b-task", "agent", SpanKind.AGENT, 20, 1990],
    ["b-s1", "b-agent", "web_search", SpanKind.TOOL, 30, 300],
    ["b-s2", "b-agent", "web_search", SpanKind.TOOL, 310, 600],
    ["b-answer", "b-agent", "compose_answer", SpanKind.LLM, 610, 1980, { total_tokens: 1200 }],
    ["b-quality", "b-eval", "quality", SpanKind.SCORER, 2010, 2990],
    ["b-judge", "b-quality", "judge", SpanKind.LLM, 2020, 2980, { total_tokens: 500 }],
  ]);
  const RUN_2 = traceOf("t2", [
    ["c-eval", null, "evaluation-item", SpanKind.EVALUATION, 0, 3500],
    ["c-task", "c-eval", "task", SpanKind.TASK, 10, 2500],
    [
      "c-s1",
      "c-agent",
      "web_search",
      SpanKind.TOOL,
      30,
      200,
      { ...under("web_search"), status: SpanStatus.ERROR },
    ],
    ["c-s2", "c-agent", "web_search", SpanKind.TOOL, 210, 500, under("web_search")],
    ["c-s3", "c-agent", "web_search", SpanKind.TOOL, 510, 800, under("web_search")],
    [
      "c-answer",
      "c-agent",
      "compose_answer",
      SpanKind.LLM,
      810,
      2480,
      { ...under("compose_answer"), total_tokens: 1900 },
    ],
    ["c-quality", "c-eval", "quality", SpanKind.SCORER, 2510, 3490],
    ["c-judge", "c-quality", "judge", SpanKind.LLM, 2520, 3480, { total_tokens: 530 }],
  ]);

  it("adds the failed first call, keeps the placeholder and reads the answer's tokens in red", () => {
    const { rows } = renderTree(
      { trace: RUN_2 },
      { baseline: RUN_1, nodes: traceUnion(RUN_1, RUN_2).nodes },
    );
    const named = rows().map((r) => [
      r.dataset.diffState,
      r.querySelector("[data-span-name]")!.textContent,
    ]);
    expect(named).toEqual([
      ["matched", "evaluation-item"],
      ["matched", "task"],
      ["matched", "agent"],
      ["added", "web_search"],
      ["matched", "web_search"],
      ["matched", "web_search"],
      ["matched", "compose_answer"],
      ["matched", "quality"],
      ["matched", "judge"],
    ]);
    const row = (name: string, i = 0) =>
      rows().filter((r) => r.querySelector("[data-span-name]")!.textContent === name)[i];

    // The agent that never arrived reads as the plain tree's placeholder does.
    expect(row("agent").querySelector("[data-span-name]")!.className).toContain(
      "text-muted-foreground/60",
    );
    // The failed attempt is the added one, in green, with its error.
    const failed = row("web_search", 0);
    expect(failed.querySelector("[data-span-name]")!.className).toContain("text-success");
    expect(failed.textContent).toContain("ERROR");

    const tokens = (name: string) =>
      row(name).querySelector<HTMLElement>('[data-metric="tokens"]')!;
    expect(tokens("compose_answer").textContent).toBe("1.2K → 1.9K");
    expect(tokens("compose_answer").className).toContain("text-danger");
    // The judge's are the evaluation's: shown, never coloured.
    expect(tokens("judge").textContent).toBe("500 → 530");
    expect(tokens("judge").className).toContain("text-muted-foreground");
  });

  it("shows the baseline's figures on a placeholder, with — for the side that never arrived", () => {
    const { rows } = renderTree(
      { trace: RUN_2 },
      { baseline: RUN_1, nodes: traceUnion(RUN_1, RUN_2).nodes },
    );
    const agent = rows().find((r) => r.querySelector("[data-span-name]")!.textContent === "agent")!;
    const duration = agent.querySelector<HTMLElement>('[data-metric="duration"]')!;
    expect(duration.textContent).toBe("2.0s → —");
    expect(duration.className).not.toContain("text-danger");
    expect(duration.className).not.toContain("text-success");
    expect(agent.dataset.diffState).toBe("matched");
  });

  it("counts the run's own spans both ways round, leaving the scorer's out", () => {
    const chip = (nodes: Parameters<typeof DivergenceChip>[0]["nodes"]) => {
      const { container } = render(<DivergenceChip nodes={nodes} />);
      return container.querySelector<HTMLElement>("[data-diff-summary]")!;
    };
    const forward = chip(traceUnion(RUN_1, RUN_2).nodes);
    expect(forward.textContent).toBe("6 matched · 1 added · 0 removed");
    expect(forward.getAttribute("title")).toBe(
      "Spans of the run under test. An evaluation's scorer spans aren't counted.",
    );
    expect(chip(traceUnion(RUN_2, RUN_1).nodes).textContent).toBe(
      "6 matched · 0 added · 1 removed",
    );
    expect(chip(null).textContent).toBe("No baseline trace to compare with");
  });
});

describe("SpanTreeView in diff mode, pairing across a move or a rename", () => {
  it("flags a span that ran under another parent as moved, with how it was paired", () => {
    // The candidate's first `step` failed and was retried; its `fetch` is drawn under the
    // retry, which pairs with the baseline's `step`.
    const baseline = traceOf("tb", [
      ["b-root", null, "agent", SpanKind.AGENT, 0, 1000],
      ["b-step", "b-root", "step", SpanKind.SPAN, 10, 500],
      ["b-fetch", "b-step", "fetch", SpanKind.TOOL, 20, 400],
    ]);
    const candidate = traceOf("tc", [
      ["c-root", null, "agent", SpanKind.AGENT, 0, 1000],
      ["c-step1", "c-root", "step", SpanKind.SPAN, 10, 300, { status: SpanStatus.ERROR }],
      ["c-fetch", "c-step1", "fetch", SpanKind.TOOL, 20, 250],
      ["c-step2", "c-root", "step", SpanKind.SPAN, 310, 900],
    ]);
    const { rows } = renderTree(
      { trace: candidate },
      { baseline, nodes: traceUnion(baseline, candidate).nodes },
    );
    const fetch = rows().find((r) => r.querySelector("[data-span-name]")!.textContent === "fetch")!;
    expect(fetch.dataset.diffState).toBe("matched");
    const moved = [...fetch.querySelectorAll("span")].find((s) => s.textContent === "moved")!;
    expect(moved.getAttribute("title")).toBe(
      "Matched by path: agent › step › tool:fetch #1 · in the candidate it sits under step #1",
    );
    // Only the span that moved is flagged.
    expect(rows().filter((r) => r.textContent?.includes("moved"))).toHaveLength(1);
  });

  it("names a root paired across a rename old → new", () => {
    const baseline = traceOf("tb", [["b-root", null, "agent", SpanKind.AGENT, 0, 1000]]);
    const candidate = traceOf("tc", [["c-root", null, "support_agent", SpanKind.AGENT, 0, 1000]]);
    const { rows } = renderTree(
      { trace: candidate },
      { baseline, nodes: traceUnion(baseline, candidate).nodes },
    );
    expect(rows().map((r) => r.querySelector("[data-span-name]")!.textContent)).toEqual([
      "agent → support_agent",
    ]);
    expect(rows()[0].dataset.diffState).toBe("matched");
  });
});
