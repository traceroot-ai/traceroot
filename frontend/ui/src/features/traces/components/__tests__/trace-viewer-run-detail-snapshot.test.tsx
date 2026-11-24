// @vitest-environment jsdom
//
// Pins the trace viewer as an evaluation run's detail page configures it: no
// detectors view, "Open in new tab" back into the run, and the span panel's
// header action and extra tags. Once for a result with a real trace (its
// "Add to datasets" action) and once for a reconstructed one (`traceOverride`
// and its "Reconstructed" tag). The tree, the span panel and the timeline are
// the real components, so their plain rendering is pinned too.
//
// Recorded before the viewer took its optional diff and host-framing props.
// With none of them set, this markup must stay byte for byte as committed.
// Never re-generate it (`-u`): a diff here means one of those props leaked
// into the plain path.
process.env.TZ = "UTC";

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Plus } from "lucide-react";
import { SpanKind, SpanStatus } from "@traceroot/core";
import { Button } from "@/components/ui/button";
import type { Span, TraceDetail } from "@/types/api";
import type { TraceSelection } from "../../types";

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
// jsdom has no ResizeObserver; the timeline keeps its default width.
(global as unknown as { ResizeObserver: typeof ResizeObserverStub }).ResizeObserver =
  ResizeObserverStub;

const T0 = Date.UTC(2026, 0, 1);
const at = (ms: number) => new Date(T0 + ms).toISOString();

function span(
  traceId: string,
  id: string,
  parent: string | null,
  name: string,
  kind: Span["span_kind"],
  start: number,
  end: number,
  extra: Partial<Span> = {},
): Span {
  return {
    span_id: id,
    trace_id: traceId,
    parent_span_id: parent,
    name,
    span_kind: kind,
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
  };
}

function traceOf(traceId: string, name: string, spans: Span[]): TraceDetail {
  return {
    trace_id: traceId,
    project_id: "p1",
    name,
    trace_start_time: at(0),
    user_id: null,
    session_id: null,
    git_ref: null,
    git_repo: null,
    environment: "evaluation",
    release: null,
    input: null,
    output: null,
    metadata: null,
    spans,
  };
}

const REAL_ID = "a".repeat(32);
// A result's ingested trace: the evaluation item, the task under test and its scorer.
const REAL_TRACE = traceOf(REAL_ID, "evaluation-item", [
  span(REAL_ID, "e0", null, "evaluation-item", SpanKind.EVALUATION, 0, 2400),
  span(REAL_ID, "t0", "e0", "task", SpanKind.TASK, 10, 1800),
  span(REAL_ID, "a0", "t0", "agent", SpanKind.AGENT, 20, 1790),
  span(REAL_ID, "w0", "a0", "web_search", SpanKind.TOOL, 30, 400),
  span(REAL_ID, "l0", "a0", "compose_answer", SpanKind.LLM, 410, 1780, {
    model_name: "gpt-4o",
    cost: 0.0042,
    input_tokens: 900,
    output_tokens: 300,
    total_tokens: 1200,
  }),
  span(REAL_ID, "s0", "e0", "quality", SpanKind.SCORER, 1810, 2390),
  span(REAL_ID, "j0", "s0", "judge", SpanKind.LLM, 1820, 2380, {
    model_name: "gpt-4o-mini",
    cost: 0.0003,
    input_tokens: 420,
    output_tokens: 80,
    total_tokens: 500,
  }),
]);

// A result that emitted no telemetry, rebuilt as the run detail page rebuilds one: the
// item at the root, the task and one span per scorer under it, on placeholder timings.
const RECONSTRUCTED_ID = "eval-r3";
const RECONSTRUCTED_TRACE = traceOf(RECONSTRUCTED_ID, "support-bot · case-3", [
  span(
    RECONSTRUCTED_ID,
    `${RECONSTRUCTED_ID}-root`,
    null,
    "support-bot · case-3",
    SpanKind.AGENT,
    0,
    3,
    {
      metadata: JSON.stringify({ evaluation: "support-bot", test_case: "case-3" }),
    },
  ),
  span(
    RECONSTRUCTED_ID,
    `${RECONSTRUCTED_ID}-task`,
    `${RECONSTRUCTED_ID}-root`,
    "task",
    SpanKind.SPAN,
    0,
    1,
    {
      metadata: JSON.stringify({ step: "task" }),
    },
  ),
  span(
    RECONSTRUCTED_ID,
    `${RECONSTRUCTED_ID}-scorer-q`,
    `${RECONSTRUCTED_ID}-root`,
    "quality",
    SpanKind.SPAN,
    2,
    2,
    { metadata: JSON.stringify({ scorer: "quality", version: "1" }) },
  ),
]);

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({ data: REAL_TRACE, isLoading: false, error: null }),
  useQueryClient: () => ({ prefetchQuery: vi.fn() }),
}));
// jsdom has no layout to measure, so every row is laid out.
vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getTotalSize: () => count * 28,
    getVirtualItems: () =>
      Array.from({ length: count }, (_, index) => ({ index, start: index * 28, size: 28 })),
    scrollToIndex: vi.fn(),
  }),
}));
vi.mock("@/lib/api", () => ({ getTrace: vi.fn(), getSpanIO: vi.fn() }));
vi.mock("@/lib/auth-client", () => ({ useSession: () => ({ data: undefined }) }));
vi.mock("../../hooks/use-trace-stream", () => ({ useTraceStream: vi.fn() }));
// The span panel lazily fetches the selection's I/O; nothing to fetch here.
vi.mock("../../hooks", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../hooks")>()),
  useSpanIO: () => ({ data: undefined, isLoading: false, error: null }),
}));
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

// The run detail page's span header action, for a result with a real trace.
const addToDatasets = (_selection: TraceSelection) => (
  <Button variant="outline" className="h-7 shrink-0 gap-1.5 text-[12px]" onClick={() => {}}>
    <Plus className="h-3.5 w-3.5" aria-hidden />
    Add to datasets
  </Button>
);

function renderRunDetail(reconstructed: boolean) {
  return render(
    <TraceViewerPanel
      projectId="p1"
      traceId={reconstructed ? RECONSTRUCTED_ID : REAL_ID}
      traceOverride={reconstructed ? RECONSTRUCTED_TRACE : undefined}
      hideDetectors
      newTabPath="/projects/p1/evaluations/run-1"
      onClose={() => {}}
      onNavigate={() => {}}
      canNavigateUp
      canNavigateDown={false}
      onSelectionChange={() => {}}
      spanHeaderAction={reconstructed ? undefined : addToDatasets}
      spanExtraTags={() => (
        <>
          {reconstructed && (
            <span className="inline-flex items-center gap-1.5 rounded-md border border-warning-border bg-warning-soft px-2.5 py-1 text-xs text-warning">
              Reconstructed — no telemetry was emitted for this result
            </span>
          )}
        </>
      )}
    />,
  );
}

afterEach(() => cleanup());

describe("trace viewer as an evaluation run's detail page configures it", () => {
  it("matches the committed snapshots for a result with a real trace", async () => {
    const { container } = renderRunDetail(false);
    await screen.findByText("Add to datasets");
    expect(screen.getAllByText("compose_answer").length).toBeGreaterThan(0);
    expect(container.innerHTML).toMatchSnapshot("tree and details");

    fireEvent.click(screen.getByRole("button", { name: /Timeline/ }));
    expect(container.innerHTML).toMatchSnapshot("timeline");
  });

  it("matches the committed snapshots for a reconstructed result", async () => {
    const { container } = renderRunDetail(true);
    await screen.findByText("Reconstructed — no telemetry was emitted for this result");
    expect(screen.queryByText("Add to datasets")).toBeNull();
    expect(container.innerHTML).toMatchSnapshot("tree and details");

    fireEvent.click(screen.getByRole("button", { name: /Timeline/ }));
    expect(container.innerHTML).toMatchSnapshot("timeline");
  });
});
