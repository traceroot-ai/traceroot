// @vitest-environment jsdom
/**
 * Regression test: the detail panel must reflect the latest span data when the
 * trace updates (via SSE stream or refetch), without requiring the user to
 * click away and back.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import type { Span, TraceDetail } from "@/types/api";

// ── mutable query state (same pattern as trace-viewer-span-deeplink) ──
const queryState = { data: null as unknown, isLoading: false };
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

// ── SpanTreeView stub: exposes an onSelect button per span ──
vi.mock("../SpanTreeView", async () => {
  const React = await import("react");
  return {
    SpanTreeView: React.forwardRef(function TreeProbe(
      props: {
        trace: TraceDetail;
        onSelect: (sel: { type: "span"; span: Span }) => void;
      },
      _ref: React.Ref<unknown>,
    ) {
      return (
        <div>
          {(props.trace.spans ?? []).map((s) => (
            <button
              key={s.span_id}
              type="button"
              data-testid={`pick-${s.span_id}`}
              onClick={() => props.onSelect({ type: "span", span: s })}
            />
          ))}
        </div>
      );
    }),
  };
});

// ── SpanInfoPanel stub: surfaces selection fields as data attributes ──
vi.mock("../SpanInfoPanel", () => ({
  SpanInfoPanel: (props: { selection?: { type: string; span?: Span } }) => {
    const span = props.selection?.type === "span" ? props.selection.span : undefined;
    return (
      <div
        data-testid="span-info"
        data-span-id={span?.span_id ?? "none"}
        data-span-status={span?.status ?? "none"}
        data-span-end={span?.span_end_time ?? "none"}
        data-span-tokens={span?.total_tokens ?? "none"}
        data-span-pending={span?.pending ?? "none"}
      />
    );
  },
}));

vi.mock("../SpanTimelineView", () => ({
  SpanTimelineView: () => <div data-testid="timeline" />,
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

// ── helpers ──

const PENDING_SPAN: Span = {
  span_id: "span-1",
  trace_id: "trace-1",
  parent_span_id: null,
  name: "llm-call",
  span_kind: "LLM",
  span_start_time: "2026-10-22T10:00:00.000Z",
  span_end_time: null,
  status: "OK",
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
  pending: true,
};

const ARRIVED_SPAN: Span = {
  span_id: "span-1",
  trace_id: "trace-1",
  parent_span_id: null,
  name: "llm-call",
  span_kind: "LLM",
  span_start_time: "2026-10-22T10:00:00.000Z",
  span_end_time: "2026-10-22T10:00:05.000Z",
  status: "ERROR",
  status_message: "rate limited",
  error_type: "RateLimitError",
  model_name: "gpt-4",
  cost: 0.05,
  input_tokens: 500,
  output_tokens: 734,
  total_tokens: 1234,
  git_source_file: null,
  git_source_line: null,
  git_source_function: null,
  pending: false,
};

function makeTrace(spans: Span[]): TraceDetail {
  return {
    trace_id: "trace-1",
    project_id: "proj-1",
    name: "test-trace",
    trace_start_time: "2026-10-22T10:00:00.000Z",
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

const baseProps = {
  projectId: "proj-1",
  traceId: "trace-1",
  onClose: vi.fn(),
  onNavigate: vi.fn(),
  canNavigateUp: false,
  canNavigateDown: false,
};

afterEach(() => {
  cleanup();
  queryState.data = null;
  queryState.isLoading = false;
});

describe("live span update", () => {
  it("updates selected span details when trace data changes", () => {
    // Initial trace with a pending span.
    queryState.data = makeTrace([PENDING_SPAN]);

    const { rerender } = render(<TraceViewerPanel {...baseProps} />);

    // Click the pending span in the tree.
    fireEvent.click(document.querySelector('[data-testid="pick-span-1"]')!);

    // Assert the panel shows the pending state.
    const info = () => document.querySelector('[data-testid="span-info"]')!;
    expect(info().getAttribute("data-span-status")).toBe("OK");
    expect(info().getAttribute("data-span-end")).toBe("none");
    expect(info().getAttribute("data-span-tokens")).toBe("none");
    expect(info().getAttribute("data-span-pending")).toBe("true");

    // Simulate the SSE stream / refetch delivering the arrived span (new
    // object, new array — not a mutation of the original).
    queryState.data = makeTrace([ARRIVED_SPAN]);
    rerender(<TraceViewerPanel {...baseProps} />);

    // The panel must now show the arrived data — without clicking away and back.
    expect(info().getAttribute("data-span-status")).toBe("ERROR");
    expect(info().getAttribute("data-span-end")).toBe("2026-10-22T10:00:05.000Z");
    expect(info().getAttribute("data-span-tokens")).toBe("1234");
    expect(info().getAttribute("data-span-pending")).toBe("false");
  });

  it("keeps a placeholder span visible until it arrives in the trace", () => {
    // Initial trace with no spans yet — but the tree generates a placeholder.
    const placeholder: Span = {
      ...PENDING_SPAN,
      span_id: "span-placeholder",
    };

    // Render with an empty trace.
    queryState.data = makeTrace([]);
    const { rerender } = render(<TraceViewerPanel {...baseProps} />);

    // Simulate the tree producing a placeholder that isn't in trace.spans.
    // We do this by rendering with the placeholder in the trace (so the tree
    // stub has a button for it), clicking, then removing it from the trace.
    queryState.data = makeTrace([placeholder]);
    rerender(<TraceViewerPanel {...baseProps} />);
    fireEvent.click(document.querySelector('[data-testid="pick-span-placeholder"]')!);

    // Now remove the placeholder from the trace — the panel should still
    // show the placeholder as a fallback.
    queryState.data = makeTrace([]);
    rerender(<TraceViewerPanel {...baseProps} />);

    const info = () => document.querySelector('[data-testid="span-info"]')!;
    expect(info().getAttribute("data-span-id")).toBe("span-placeholder");
    expect(info().getAttribute("data-span-status")).toBe("OK");
    expect(info().getAttribute("data-span-pending")).toBe("true");

    // Now the real span arrives.
    const realSpan: Span = {
      ...ARRIVED_SPAN,
      span_id: "span-placeholder",
    };
    queryState.data = makeTrace([realSpan]);
    rerender(<TraceViewerPanel {...baseProps} />);

    expect(info().getAttribute("data-span-id")).toBe("span-placeholder");
    expect(info().getAttribute("data-span-status")).toBe("ERROR");
    expect(info().getAttribute("data-span-end")).toBe("2026-10-22T10:00:05.000Z");
    expect(info().getAttribute("data-span-tokens")).toBe("1234");
    expect(info().getAttribute("data-span-pending")).toBe("false");
  });
});
