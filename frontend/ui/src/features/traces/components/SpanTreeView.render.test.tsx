// @vitest-environment jsdom
// Render-level coverage for SpanTreeView's token/cost icon badges (both the
// trace-root rollup and the per-LLM-span badge). SpanTreeView.test.ts covers
// the pure row-model logic; this file exercises the actual JSX, which needs
// @tanstack/react-virtual mocked since jsdom has no real layout to measure.
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { SpanKind, SpanStatus } from "@traceroot/core";
import type { TraceDetail } from "@/types/api";
import type { TraceSelection } from "../types";
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

vi.mock("@/lib/auth-client", () => ({
  useSession: () => ({ data: undefined }),
}));

vi.mock("@/lib/api", () => ({
  getSpanIO: vi.fn(),
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

function renderTree() {
  render(
    <SpanTreeView
      trace={trace}
      selection={selection}
      onSelect={vi.fn()}
      collapsedIds={new Set()}
      onToggleCollapse={vi.fn()}
      hoveredSpanId={null}
      onHoverChange={vi.fn()}
      scrollRef={{ current: null }}
    />,
  );
}

describe("SpanTreeView token/cost badges", () => {
  it("renders the trace row and the LLM span row with their token/cost badges", () => {
    renderTree();
    // Trace root name and the one LLM span's name are both rendered.
    expect(screen.getByText("root-trace")).toBeTruthy();
    expect(screen.getByText("llm-call")).toBeTruthy();
    // Cost appears twice: the trace rollup (0.0123) and the span's own (0.0123) —
    // both format to the same 4-decimal string here since there's only one span.
    expect(screen.getAllByText("0.0123").length).toBeGreaterThan(0);
  });
});
