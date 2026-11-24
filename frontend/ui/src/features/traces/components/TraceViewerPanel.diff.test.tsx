// @vitest-environment jsdom
/**
 * The trace viewer's diff mode and the hooks a host framing it uses (the evaluation
 * comparison's trace panel): the header names the host's item, a Diff toggle beside the
 * view tabs compares the trace with a baseline trace of the same case, the host's controls
 * and the divergence sit beside it while it is on, and a host with no trace to show puts
 * its own notice in place of the tree and details.
 */
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { SpanKind, SpanStatus } from "@traceroot/core";
import type { Span, TraceDetail } from "@/types/api";

const mocks = vi.hoisted(() => ({
  traces: new Map<string, unknown>(),
  queries: [] as Array<{ queryKey: unknown[]; enabled?: boolean }>,
}));

vi.mock("@/components/layout/app-layout", () => ({
  useLayout: () => ({
    aiPanelOpen: false,
    setAiPanelOpen: vi.fn(),
    setAiContext: vi.fn(),
    setAiInitialSessionId: vi.fn(),
    registerAiHost: () => () => {},
    sidebarCollapsed: false,
  }),
}));
vi.mock("@tanstack/react-query", () => ({
  useQuery: (options: { queryKey: unknown[]; enabled?: boolean }) => {
    mocks.queries.push(options);
    const data =
      options.enabled === false ? undefined : mocks.traces.get(String(options.queryKey[2]));
    return { data, isLoading: false, error: null };
  },
}));
vi.mock("@/lib/api", () => ({ getTrace: vi.fn() }));
vi.mock("../hooks/use-trace-stream", () => ({ useTraceStream: vi.fn() }));
vi.mock("@/features/detectors/hooks/use-findings", () => ({
  useTraceFindings: () => ({ data: undefined }),
  useRca: () => ({ data: undefined }),
}));
// The tree reports the diff it was given and lets a test select any span.
vi.mock("./SpanTreeView", async () => {
  const React = await import("react");
  return {
    SpanTreeView: React.forwardRef(function TreeProbe(
      props: {
        diff?: { nodes: unknown[]; measured: boolean };
        selection: { type: string; span?: { span_id: string } };
        onSelect: (sel: unknown) => void;
      },
      _ref: React.Ref<unknown>,
    ) {
      return (
        <div
          data-testid="tree"
          data-diff-nodes={props.diff ? props.diff.nodes.length : "none"}
          data-measured={props.diff ? String(props.diff.measured) : undefined}
          data-selected={props.selection.type === "span" ? props.selection.span!.span_id : "trace"}
        >
          <button type="button" onClick={() => props.onSelect({ type: "span", span: SPAN_B1 })}>
            select-baseline-search
          </button>
        </div>
      );
    }),
  };
});
vi.mock("./SpanTimelineView", () => ({
  SpanTimelineView: (props: { diff?: { nodes: unknown[] } }) => (
    <div data-testid="timeline" data-diff-nodes={props.diff ? props.diff.nodes.length : "none"} />
  ),
}));
// The detail panel reports the diff it was given.
vi.mock("./SpanInfoPanel", () => ({
  SpanInfoPanel: (props: {
    diff?: {
      node: { id: string } | null;
      layout: string;
      onLayoutChange: (layout: string) => void;
      root?: { body?: React.ReactNode };
      sides?: { candidate: { label: string } };
    };
  }) => (
    <div
      data-testid="span-info"
      data-diff-node={props.diff ? (props.diff.node?.id ?? "root") : "none"}
      data-layout={props.diff?.layout}
      data-candidate={props.diff?.sides?.candidate.label}
    >
      {props.diff?.root?.body}
      <button type="button" onClick={() => props.diff?.onLayoutChange("inline")}>
        inline-layout
      </button>
    </div>
  ),
}));
vi.mock("./TraceDetectorsTab", () => ({ TraceDetectorsTab: () => null }));
vi.mock("@/features/ai-assistant/components/ai-assistant-panel", () => ({
  AiAssistantPanel: () => null,
}));
vi.mock("@/components/ui/resizable", () => ({
  ResizablePanelGroup: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  ResizablePanel: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  ResizableHandle: () => null,
}));

import { TraceViewerPanel } from "./TraceViewerPanel";

const T0 = Date.UTC(2026, 10, 1, 10);
const at = (ms: number) => new Date(T0 + ms).toISOString();

function span(
  traceId: string,
  id: string,
  parent: string | null,
  name: string,
  kind: Span["span_kind"],
): Span {
  return {
    span_id: id,
    trace_id: traceId,
    parent_span_id: parent,
    name,
    span_kind: kind,
    span_start_time: at(0),
    span_end_time: at(100),
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
  };
}

function traceOf(traceId: string, spans: Span[]): TraceDetail {
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

// The baseline searches; the candidate answers instead. Both evaluate with a judge whose
// extra call is the evaluation's, not the run's.
const BASELINE = traceOf("trace-b", [
  span("trace-b", "b0", null, "agent", SpanKind.AGENT),
  span("trace-b", "b1", "b0", "web_search", SpanKind.TOOL),
  span("trace-b", "b2", "b0", "faithfulness", SpanKind.SCORER),
]);
const SPAN_B1 = BASELINE.spans[1];
const CANDIDATE = traceOf("trace-c", [
  span("trace-c", "c0", null, "agent", SpanKind.AGENT),
  span("trace-c", "c1", "c0", "answer", SpanKind.LLM),
  span("trace-c", "c2", "c0", "faithfulness", SpanKind.SCORER),
  span("trace-c", "c3", "c2", "judge", SpanKind.LLM),
]);

type Props = React.ComponentProps<typeof TraceViewerPanel>;
const renderPanel = (props: Partial<Props> = {}) =>
  render(
    <TraceViewerPanel
      projectId="p1"
      traceId="trace-c"
      onClose={vi.fn()}
      onNavigate={vi.fn()}
      canNavigateUp
      canNavigateDown
      embedded
      hideDetectors
      {...props}
    />,
  );

beforeEach(() => {
  mocks.traces = new Map([["trace-c", CANDIDATE]]);
  mocks.queries = [];
});
afterEach(() => cleanup());

describe("TraceViewerPanel framed by a host", () => {
  it("names the host's item in the header, on its controls too", () => {
    const onNavigate = vi.fn();
    const onClose = vi.fn();
    renderPanel({
      onNavigate,
      onClose,
      headerItem: { title: <span>Case 2 of 12</span>, noun: "case" },
    });

    expect(screen.getByText("Case 2 of 12")).toBeTruthy();
    expect(screen.queryByText("trace-c")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Previous case" }));
    fireEvent.click(screen.getByRole("button", { name: "Next case" }));
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onNavigate.mock.calls).toEqual([["up"], ["down"]]);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("reports full screen to the host, which sizes an embedded viewer itself", () => {
    const onFullscreenChange = vi.fn();
    const { container } = renderPanel({
      headerItem: { title: "Case 1 of 1", noun: "case", onFullscreenChange },
    });

    fireEvent.click(screen.getByRole("button", { name: "Expand to full screen" }));
    fireEvent.click(screen.getByRole("button", { name: "Restore default size" }));
    expect(onFullscreenChange.mock.calls).toEqual([[true], [false]]);
    // The host's own edge is the panel's edge.
    expect((container.firstElementChild as HTMLElement).className).not.toContain("border-l");
  });

  it("shows the host's notice in place of the trace, and fetches nothing", () => {
    renderPanel({
      traceId: "",
      notice: <p>No result in this run</p>,
      headerItem: { title: "Case 9 of 12", noun: "case" },
    });

    expect(screen.getByText("No result in this run")).toBeTruthy();
    expect(screen.queryByTestId("tree")).toBeNull();
    expect(screen.queryByTestId("span-info")).toBeNull();
    expect(screen.queryByText("Error loading trace")).toBeNull();
    expect(mocks.queries.every((q) => q.enabled === false)).toBe(true);
    // Nothing to open in a tab of its own either.
    expect(screen.queryByRole("button", { name: "Open in new tab" })).toBeNull();
    // The view bar stays, so the host's controls do too.
    expect(screen.getByRole("button", { name: /Trace/ })).toBeTruthy();
  });
});

describe("TraceViewerPanel diff mode", () => {
  const diffToggle = () => screen.getByRole("button", { name: "Diff" });
  const summary = () => document.querySelector<HTMLElement>("[data-diff-summary]")!;

  it("offers a Diff toggle only when given a baseline, off unless asked", () => {
    renderPanel();
    expect(screen.queryByRole("button", { name: "Diff" })).toBeNull();
    cleanup();

    renderPanel({ diffBaseline: { trace: BASELINE } });
    expect(diffToggle().getAttribute("aria-pressed")).toBe("false");
    cleanup();

    renderPanel({ diffBaseline: { trace: BASELINE }, defaultDiffOn: true });
    expect(diffToggle().getAttribute("aria-pressed")).toBe("true");
  });

  it("stays as set while the host moves the panel to another trace", () => {
    mocks.traces.set("trace-d", CANDIDATE);
    const panel = (traceId: string, baseline: TraceDetail) => (
      <TraceViewerPanel
        projectId="p1"
        traceId={traceId}
        onClose={vi.fn()}
        onNavigate={vi.fn()}
        canNavigateUp
        canNavigateDown
        embedded
        hideDetectors
        diffBaseline={{ trace: baseline }}
      />
    );
    const { rerender } = render(panel("trace-c", BASELINE));
    expect(diffToggle().getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(diffToggle());
    expect(diffToggle().getAttribute("aria-pressed")).toBe("true");

    rerender(panel("trace-d", traceOf("trace-b2", BASELINE.spans)));
    expect(diffToggle().getAttribute("aria-pressed")).toBe("true");
  });

  it("titles the toggle for what it does", () => {
    renderPanel({ diffBaseline: { trace: BASELINE } });
    expect(screen.getByTitle("Compare each span with the baseline run's trace")).toBe(diffToggle());
  });

  it("shows how the traces diverge, and the host's controls, while it is on", () => {
    renderPanel({
      diffBaseline: { trace: BASELINE },
      diffToolbar: <button type="button">Swap</button>,
    });
    expect(screen.queryByRole("button", { name: "Swap" })).toBeNull();
    expect(screen.queryByText(/matched/)).toBeNull();

    fireEvent.click(diffToggle());

    expect(diffToggle().getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: "Swap" })).toBeTruthy();
    // The root matches; the answer is added and the search removed. The scorer and its
    // judge are the evaluation's, not the run's, and aren't counted.
    expect(summary().textContent).toBe("1 matched · 1 added · 1 removed");

    fireEvent.click(diffToggle());
    expect(screen.queryByRole("button", { name: "Swap" })).toBeNull();
    expect(document.querySelector("[data-diff-summary]")).toBeNull();
  });

  it("says why there is no baseline trace to compare with", () => {
    renderPanel({
      diffBaseline: { trace: null, unavailable: "#1 has no result for this case" },
      defaultDiffOn: true,
    });

    expect(summary().textContent).toBe("#1 has no result for this case");
  });
});

describe("TraceViewerPanel diff mode in the tree", () => {
  const tree = () => screen.getByTestId("tree");
  const panel = (baseline: TraceDetail | null) => (
    <TraceViewerPanel
      projectId="p1"
      traceId="trace-c"
      onClose={vi.fn()}
      onNavigate={vi.fn()}
      canNavigateUp
      canNavigateDown
      embedded
      hideDetectors
      diffBaseline={{ trace: baseline }}
      defaultDiffOn
    />
  );

  it("hands the tree the union only while diffing", () => {
    renderPanel({ diffBaseline: { trace: BASELINE } });
    expect(tree().dataset.diffNodes).toBe("none");
    fireEvent.click(screen.getByRole("button", { name: "Diff" }));
    // agent, web_search, answer, faithfulness, judge.
    expect(tree().dataset.diffNodes).toBe("5");
    expect(tree().dataset.measured).toBe("true");
  });

  it("compares no figures when either trace is a reconstruction", () => {
    renderPanel({ diffBaseline: { trace: BASELINE, reconstructed: true }, defaultDiffOn: true });
    expect(tree().dataset.measured).toBe("false");
    cleanup();
    renderPanel({
      diffBaseline: { trace: BASELINE },
      defaultDiffOn: true,
      traceOverride: CANDIDATE,
    });
    expect(tree().dataset.measured).toBe("false");
  });

  it("goes back to the root when a span only the baseline has can't be shown any more", () => {
    renderPanel({ diffBaseline: { trace: BASELINE }, defaultDiffOn: true });
    fireEvent.click(screen.getByText("select-baseline-search"));
    expect(tree().dataset.selected).toBe("b1");

    fireEvent.click(screen.getByRole("button", { name: "Diff" }));
    expect(tree().dataset.selected).toBe("trace");
  });

  it("goes back to the root when another baseline doesn't have the span only the old one had", () => {
    const { rerender } = render(panel(BASELINE));
    fireEvent.click(screen.getByText("select-baseline-search"));
    expect(tree().dataset.selected).toBe("b1");

    // Another run's trace of the case, which never searched.
    rerender(panel(traceOf("trace-e", [span("trace-e", "e0", null, "agent", SpanKind.AGENT)])));
    expect(tree().dataset.selected).toBe("trace");
    // Diff mode stays on; only the selection moved.
    expect(screen.getByRole("button", { name: "Diff" }).getAttribute("aria-pressed")).toBe("true");

    fireEvent.click(screen.getByText("select-baseline-search"));
    rerender(panel(null));
    expect(tree().dataset.selected).toBe("trace");
  });

  it("goes back to the root when this trace reuses the old baseline's span id for another span", () => {
    // This trace's answer has the id of the old baseline's search: span ids are only
    // unique within a trace.
    mocks.traces.set(
      "trace-c",
      traceOf("trace-c", [
        CANDIDATE.spans[0],
        { ...CANDIDATE.spans[1], span_id: "b1" },
        ...CANDIDATE.spans.slice(2),
      ]),
    );
    const { rerender } = render(panel(BASELINE));
    fireEvent.click(screen.getByText("select-baseline-search"));
    expect(tree().dataset.selected).toBe("b1");

    rerender(panel(traceOf("trace-e", [span("trace-e", "e0", null, "agent", SpanKind.AGENT)])));
    expect(tree().dataset.selected).toBe("trace");
  });

  it("hands the timeline the same union while diffing", () => {
    renderPanel({ diffBaseline: { trace: BASELINE } });
    fireEvent.click(screen.getByRole("button", { name: /Timeline/ }));
    expect(screen.getByTestId("timeline").dataset.diffNodes).toBe("none");
    fireEvent.click(screen.getByRole("button", { name: "Diff" }));
    expect(screen.getByTestId("timeline").dataset.diffNodes).toBe("5");
  });
});

describe("TraceViewerPanel diff mode in the details", () => {
  const info = () => screen.getByTestId("span-info");

  it("hands the details the selected span's node, and the host's case at the root", () => {
    renderPanel({
      diffBaseline: {
        trace: BASELINE,
        root: { body: <p>Case outputs</p> },
        sides: { baseline: { label: "Baseline" }, candidate: { label: "Candidate" } },
      },
      defaultDiffOn: true,
    });
    expect(info().dataset.diffNode).toBe("root");
    expect(screen.getByText("Case outputs")).toBeTruthy();
    expect(info().dataset.candidate).toBe("Candidate");

    fireEvent.click(screen.getByText("select-baseline-search"));
    expect(info().dataset.diffNode).toBe("baseline:b1");

    fireEvent.click(screen.getByRole("button", { name: "Diff" }));
    expect(info().dataset.diffNode).toBe("none");
  });

  it("keeps the diff layout as the selection moves", () => {
    renderPanel({ diffBaseline: { trace: BASELINE }, defaultDiffOn: true });
    expect(info().dataset.layout).toBe("columns");
    fireEvent.click(screen.getByText("inline-layout"));
    fireEvent.click(screen.getByText("select-baseline-search"));
    expect(info().dataset.layout).toBe("inline");
  });

  it("shows the host's case at the root even with no baseline trace", () => {
    renderPanel({
      diffBaseline: { trace: null, unavailable: "No result", root: { body: <p>Case outputs</p> } },
      defaultDiffOn: true,
    });
    expect(info().dataset.diffNode).toBe("root");
    expect(screen.getByText("Case outputs")).toBeTruthy();
  });
});
