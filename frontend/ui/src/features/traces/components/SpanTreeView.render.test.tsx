// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { createRef } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { SpanKind, SpanStatus } from "@traceroot/core";
import type { Span, TraceDetail } from "@/types/api";

// Render every row: the real virtualizer measures a zero-height scroll
// element under jsdom and would mount nothing. The scrollToIndex spy is
// exposed for the imperative scroll-to-span test.
vi.mock("@tanstack/react-virtual", () => {
  const scrollToIndex = vi.fn();
  (globalThis as Record<string, unknown>).__treeScrollToIndex = scrollToIndex;
  return {
    useVirtualizer: ({ count }: { count: number }) => ({
      getTotalSize: () => count * 28,
      getVirtualItems: () =>
        Array.from({ length: count }, (_, index) => ({ index, start: index * 28, size: 28 })),
      scrollToIndex,
    }),
  };
});

vi.mock("@/lib/auth-client", () => ({
  useSession: () => ({ data: { user: { id: "u1", email: "u@x.dev" } } }),
}));
const getSpanIO = vi.fn().mockResolvedValue({ input: null, output: null, metadata: null });
vi.mock("@/lib/api", () => ({
  getSpanIO: (...a: unknown[]) => getSpanIO(...a),
}));
vi.mock("../hooks", () => ({
  spanIOQueryKey: (p: string, t: string, s: string) => ["span-io", p, t, s],
  SPAN_IO_STALE_TIME_MS: 300_000,
}));

import { SpanTreeView, type SpanTreeViewHandle } from "./SpanTreeView";

// Minimal span factory — only fields the tree reads.
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

const spans = [
  makeSpan({
    span_id: "root",
    name: "root_span",
    span_start_time: "2024-01-01T00:00:00.000Z",
    span_end_time: "2024-01-01T00:00:10.000Z",
  }),
  makeSpan({
    span_id: "agent",
    name: "agent_turn",
    parent_span_id: "root",
    span_start_time: "2024-01-01T00:00:00.500Z",
    span_end_time: "2024-01-01T00:00:09.000Z",
  }),
  makeSpan({
    span_id: "llm",
    name: "llm_call",
    parent_span_id: "agent",
    span_kind: SpanKind.LLM,
    span_start_time: "2024-01-01T00:00:01.000Z",
    span_end_time: "2024-01-01T00:00:05.000Z",
    input_tokens: 1000,
    output_tokens: 500,
    total_tokens: 1500,
    cost: 0.0123,
  }),
  makeSpan({
    span_id: "bad",
    name: "broken_tool",
    parent_span_id: "agent",
    status: SpanStatus.ERROR,
    span_start_time: "2024-01-01T00:00:06.000Z",
    span_end_time: "2024-01-01T00:00:07.000Z",
  }),
  // Orphan whose metadata names its missing ancestor — enrichment must
  // synthesize a pending "ghost_stage" placeholder row.
  makeSpan({
    span_id: "deep",
    name: "deep_step",
    parent_span_id: "ghost01",
    span_start_time: "2024-01-01T00:00:08.000Z",
    span_end_time: "2024-01-01T00:00:08.500Z",
    metadata: JSON.stringify({
      "traceroot.span.ids_path": ["root", "ghost01"],
      "traceroot.span.path": ["root_span", "ghost_stage", "deep_step"],
    }),
  }),
];

const trace = {
  trace_id: "t1",
  project_id: "p1",
  name: "demo-trace",
  spans,
} as unknown as TraceDetail;

function renderTree(overrides: Partial<Parameters<typeof SpanTreeView>[0]> = {}) {
  const onSelect = vi.fn();
  const onHoverChange = vi.fn();
  const onToggleCollapse = vi.fn();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const ref = createRef<SpanTreeViewHandle>();
  const utils = render(
    <QueryClientProvider client={client}>
      <SpanTreeView
        ref={ref}
        trace={trace}
        selection={{ type: "trace" }}
        onSelect={onSelect}
        collapsedIds={new Set()}
        onToggleCollapse={onToggleCollapse}
        hoveredSpanId={null}
        onHoverChange={onHoverChange}
        scrollRef={createRef<HTMLDivElement>()}
        {...overrides}
      />
    </QueryClientProvider>,
  );
  return { onSelect, onHoverChange, onToggleCollapse, ref, ...utils };
}

afterEach(() => {
  cleanup();
  getSpanIO.mockClear();
});

describe("SpanTreeView rendering", () => {
  it("renders the trace root with aggregates and every span row", () => {
    renderTree();
    expect(screen.getByText("demo-trace")).toBeTruthy();
    expect(screen.getByText("agent_turn")).toBeTruthy();
    expect(screen.getByText("llm_call")).toBeTruthy();
    expect(screen.getByText("ERROR")).toBeTruthy();
    // Pending placeholder synthesized from the orphan's metadata
    expect(screen.getByText("ghost_stage")).toBeTruthy();
    expect(screen.getByText("deep_step")).toBeTruthy();
    // LLM metrics and trace aggregates
    expect(screen.getAllByText(/1\.5K/).length).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByText("0.0123").length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText("4.0s")).toBeTruthy();
  });

  it("hides per-row metrics in compact mode", () => {
    renderTree({ compact: true });
    expect(screen.getByText("llm_call")).toBeTruthy();
    expect(screen.queryByText("4.0s")).toBeNull();
    expect(screen.queryByText(/1\.5K/)).toBeNull();
  });

  it("selects a span on click and reports hover changes", () => {
    const { onSelect, onHoverChange } = renderTree();
    const row = screen.getByText("llm_call").closest("div.group")!;
    fireEvent.mouseEnter(row);
    expect(onHoverChange).toHaveBeenCalledWith("llm");
    fireEvent.mouseLeave(row);
    expect(onHoverChange).toHaveBeenCalledWith(null);
    fireEvent.click(row);
    expect(onSelect).toHaveBeenCalledWith({ type: "span", span: spans[2] });
  });

  it("prefetches span I/O after an intentional hover, not a pass-over", async () => {
    renderTree();
    const row = screen.getByText("llm_call").closest("div.group")!;
    // Quick pass-over: leave before the debounce elapses → no request.
    fireEvent.mouseEnter(row);
    fireEvent.mouseLeave(row);
    await new Promise((r) => setTimeout(r, 250));
    expect(getSpanIO).not.toHaveBeenCalled();
    // Intentional hover: the debounced prefetch fires with the auth user.
    fireEvent.mouseEnter(row);
    await waitFor(() => expect(getSpanIO).toHaveBeenCalled(), { timeout: 2000 });
    expect(getSpanIO).toHaveBeenCalledWith("p1", "t1", "llm", { id: "u1", email: "u@x.dev" });
  });

  it("toggles collapse from the row chevron and the trace root chevron", () => {
    const { onToggleCollapse } = renderTree();
    const agentRow = screen.getByText("agent_turn").closest("div.group")!;
    fireEvent.click(within(agentRow as HTMLElement).getByRole("button"));
    expect(onToggleCollapse).toHaveBeenCalledWith("agent");

    const traceRow = screen.getByText("demo-trace").closest('div[class*="cursor-pointer"]')!;
    fireEvent.click(within(traceRow as HTMLElement).getByRole("button"));
    expect(onToggleCollapse).toHaveBeenCalledWith("trace");
  });

  it("scrolls to a visible span via the imperative handle", () => {
    const { ref } = renderTree();
    const scrollToIndex = (globalThis as Record<string, unknown>).__treeScrollToIndex as ReturnType<
      typeof vi.fn
    >;
    scrollToIndex.mockClear();
    act(() => ref.current!.scrollToSpan("llm"));
    expect(scrollToIndex).toHaveBeenCalledWith(expect.any(Number), { align: "center" });
    scrollToIndex.mockClear();
    act(() => ref.current!.scrollToSpan("not-a-span"));
    expect(scrollToIndex).not.toHaveBeenCalled();
  });
});
