// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";

const trace = {
  trace_id: "f".repeat(32),
  name: "rca: Failure Detector",
  source: "agent",
  trace_start_time: "2026-01-01T00:00:00Z",
  metadata: JSON.stringify({
    kind: "rca",
    finding_id: "3817f98c-1876-6de9-30a2-66452c8e1e9f",
    attempt: 1,
  }),
  spans: [
    {
      span_id: "s1",
      parent_span_id: null,
      name: "rca: Failure Detector",
      span_kind: "AGENT",
      status: "OK",
      span_start_time: "2026-01-01T00:00:00Z",
      span_end_time: "2026-01-01T00:00:01Z",
    },
    {
      span_id: "s2",
      parent_span_id: "s1",
      name: "read",
      span_kind: "TOOL",
      status: "OK",
      span_start_time: "2026-01-01T00:00:00Z",
      span_end_time: "2026-01-01T00:00:01Z",
    },
  ],
};

// Mutable so a test can model spans arriving after the first render (they
// stream in over SSE) and the loading state that distinguishes "not yet" from
// "not in this trace".
const queryState = { data: trace as unknown, isLoading: false };
vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({ data: queryState.data, isLoading: queryState.isLoading, error: null }),
}));
vi.mock("@/lib/api", () => ({ getTrace: vi.fn() }));
vi.mock("../../hooks/use-trace-stream", () => ({ useTraceStream: vi.fn() }));
vi.mock("@/features/detectors/hooks/use-findings", () => ({
  useTraceFindings: () => ({ data: { findings: [] } }),
  useRca: () => ({ data: { rca: null } }),
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
vi.mock("../SpanTreeView", () => ({
  // Expose the tree's selection path: clicking the button is the test's stand-in
  // for the user picking the root span by hand in the tree.
  SpanTreeView: (props: {
    onSelect?: (sel: { type: "span"; span: (typeof trace.spans)[number] }) => void;
  }) => (
    <button
      type="button"
      data-testid="pick-s1"
      onClick={() => props.onSelect?.({ type: "span", span: trace.spans[0] })}
    />
  ),
}));
vi.mock("../SpanInfoPanel", () => ({
  SpanInfoPanel: (props: { selection?: { type: string; span?: { span_id?: string } } }) => (
    <div
      data-testid="span-info"
      data-span={props.selection?.type === "span" ? props.selection.span?.span_id : "none"}
    />
  ),
}));
vi.mock("../SpanTimelineView", () => ({ SpanTimelineView: () => <div data-testid="timeline" /> }));
vi.mock("../TraceDetectorsTab", () => ({
  TraceDetectorsTab: () => <div data-testid="detectors-tab" />,
}));
vi.mock("@/features/ai-assistant/components/ai-assistant-panel", () => ({
  AiAssistantPanel: () => <div data-testid="ai-panel" />,
}));
vi.mock("@/components/RetentionGateBanner", () => ({
  RetentionGateBanner: () => <div data-testid="retention-banner" />,
}));
vi.mock("@/components/ui/resizable", () => ({
  ResizablePanelGroup: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  ResizablePanel: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  ResizableHandle: () => null,
}));

import { TraceViewerPanel } from "../TraceViewerPanel";

afterEach(() => {
  cleanup();
  queryState.data = trace;
  queryState.isLoading = false;
});

/**
 * `initialSpanId` is how a sidebar tool step's "Open span" asks the sheet to
 * land on that step's span. The panel declares the deep-link effect before the
 * "reset when the trace changes" effect, and React runs effects in declaration
 * order — so on mount the reset ran second and cleared what the deep link had
 * just applied, and every "Open span" landed on the trace root instead.
 *
 * SpanInfoPanel is stubbed to expose which span it was handed, which is the
 * selection the panel resolved.
 */
function selectedSpan(container: HTMLElement): string {
  return container.querySelector("[data-testid=span-info]")?.getAttribute("data-span") ?? "missing";
}

it("keeps the deep-linked span selected on mount", async () => {
  const { container, findByTestId } = render(
    <TraceViewerPanel
      projectId="p1"
      traceId={trace.trace_id}
      source="agent"
      initialSpanId="s2"
      onClose={vi.fn()}
      onNavigate={vi.fn()}
      canNavigateUp={false}
      canNavigateDown={false}
    />,
  );
  await findByTestId("span-info");
  expect(selectedSpan(container)).toBe("s2");
});

it("clears a selected span when a stale deep link is not in this trace", async () => {
  // Mount with a valid deep link so a span is genuinely selected, then rerender
  // with an id from another trace: the fallback has to *clear* that selection.
  // Asserting on a fresh mount would pass even if the fallback did nothing,
  // since selection starts at { type: "trace" }.
  const props = {
    projectId: "p1",
    traceId: trace.trace_id,
    source: "agent" as const,
    onClose: vi.fn(),
    onNavigate: vi.fn(),
    canNavigateUp: false,
    canNavigateDown: false,
  };
  const { container, rerender, findByTestId } = render(
    <TraceViewerPanel {...props} initialSpanId="s2" />,
  );
  await findByTestId("span-info");
  expect(selectedSpan(container)).toBe("s2");

  rerender(<TraceViewerPanel {...props} initialSpanId="span-from-another-trace" />);
  await findByTestId("span-info");
  expect(selectedSpan(container)).toBe("none");
});

it("falls back to the trace root even when the trace loads with zero spans", async () => {
  // A span from the previous trace is selected, then the next trace arrives
  // with an empty span list (SSE delivers spans later). Gating the fallback on
  // spans being present would leave the stale span selected.
  const props = {
    projectId: "p1",
    traceId: trace.trace_id,
    source: "agent" as const,
    onClose: vi.fn(),
    onNavigate: vi.fn(),
    canNavigateUp: false,
    canNavigateDown: false,
  };
  const { container, rerender, findByTestId } = render(
    <TraceViewerPanel {...props} initialSpanId="s2" />,
  );
  await findByTestId("span-info");
  expect(selectedSpan(container)).toBe("s2");

  queryState.data = { ...trace, spans: [] };
  rerender(<TraceViewerPanel {...props} initialSpanId="span-from-another-trace" />);
  await findByTestId("span-info");
  expect(selectedSpan(container)).toBe("none");
});

it("still applies the deep link when the span arrives after the first render", async () => {
  // Spans stream in: the trace can render before the deep-linked span lands.
  // Treating that first miss as final would strand the viewer on the root.
  queryState.data = { ...trace, spans: [trace.spans[0]] };
  const props = {
    projectId: "p1",
    traceId: trace.trace_id,
    source: "agent" as const,
    initialSpanId: "s2",
    onClose: vi.fn(),
    onNavigate: vi.fn(),
    canNavigateUp: false,
    canNavigateDown: false,
  };
  const { container, rerender, findByTestId } = render(<TraceViewerPanel {...props} />);
  await findByTestId("span-info");
  expect(selectedSpan(container)).toBe("none");

  queryState.data = trace;
  rerender(<TraceViewerPanel {...props} />);
  await findByTestId("span-info");
  expect(selectedSpan(container)).toBe("s2");
});

it("selects the trace when nothing is deep-linked", async () => {
  const { container, findByTestId } = render(
    <TraceViewerPanel
      projectId="p1"
      traceId={trace.trace_id}
      source="agent"
      onClose={vi.fn()}
      onNavigate={vi.fn()}
      canNavigateUp={false}
      canNavigateDown={false}
    />,
  );
  await findByTestId("span-info");
  expect(selectedSpan(container)).toBe("none");
});

it("does not keep clearing a manual selection while waiting for a late span", async () => {
  // Spans arrive over SSE. Applying the fallback on every batch would reset a
  // span the user picked by hand, over and over, until the deep-linked one
  // shows up — or forever, if it never does.
  queryState.data = { ...trace, spans: [trace.spans[0]] };
  const props = {
    projectId: "p1",
    traceId: trace.trace_id,
    source: "agent" as const,
    initialSpanId: "never-arrives",
    onClose: vi.fn(),
    onNavigate: vi.fn(),
    canNavigateUp: false,
    canNavigateDown: false,
  };
  const { container, rerender, findByTestId, getByTestId } = render(
    <TraceViewerPanel {...props} />,
  );
  await findByTestId("span-info");
  expect(selectedSpan(container)).toBe("none");

  // The user picks a span by hand while the deep-linked one is still missing…
  fireEvent.click(getByTestId("pick-s1"));
  expect(selectedSpan(container)).toBe("s1");

  // …then a later batch adds an unrelated span. The fallback must not fire
  // again and clobber the manual selection back to the trace root.
  queryState.data = { ...trace };
  rerender(<TraceViewerPanel {...props} />);
  await findByTestId("span-info");
  expect(selectedSpan(container)).toBe("s1");
});
