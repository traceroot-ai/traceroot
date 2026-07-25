// @vitest-environment jsdom
/**
 * SpanInfoPanel rendering of OTEL span events: the exception error panel
 * (including the TS-SDK case where status_message is null and the exception
 * event is the only error evidence) and the Events section.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, cleanup, screen } from "@testing-library/react";
import React from "react";
import { SpanStatus } from "@traceroot/core";
import { SpanInfoPanel } from "./SpanInfoPanel";
import type { SpanIO, TraceDetail } from "@/types/api";
import type { TraceSelection } from "../types";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

// Configurable per-test: each test assigns the span I/O (with events) the
// lazy fetch would return.
let mockSpanIO: SpanIO | null = null;
vi.mock("../hooks", () => ({
  useSpanIO: () => ({ data: mockSpanIO, isLoading: false }),
}));

vi.mock("@/components/ui/copy-button", () => ({
  CopyButton: () => <button data-testid="copy-button" />,
}));

vi.mock("@/components/ui/expandable-section", () => ({
  ExpandableSection: ({ children, title }: { children: React.ReactNode; title: string }) => (
    <div data-testid={`expandable-${title.toLowerCase()}`}>{children}</div>
  ),
}));

vi.mock("./ContentRenderer", () => ({
  ContentRenderer: () => <div data-testid="content-renderer" />,
}));

vi.mock("./SpanKindIcon", () => ({
  SpanKindIcon: () => <div data-testid="span-kind-icon" />,
}));

afterEach(() => {
  cleanup();
  mockSpanIO = null;
});

const STACKTRACE =
  "Traceback (most recent call last):\n" +
  '  File "/app/agents/checkout.py", line 42, in run_checkout\n' +
  "    total = subtotal / item_count\n" +
  "ZeroDivisionError: division by zero\n";

const EXCEPTION_EVENTS_BLOB = JSON.stringify([
  {
    name: "exception",
    timestamp: "2026-07-12T12:00:00.500000",
    attributes: {
      "exception.type": "ZeroDivisionError",
      "exception.message": "division by zero",
      "exception.stacktrace": STACKTRACE,
    },
  },
]);

const trace: TraceDetail = {
  trace_id: "trace-123",
  project_id: "proj-123",
  name: "test-trace",
  trace_start_time: "2026-07-12T12:00:00Z",
  user_id: null,
  session_id: null,
  git_ref: null,
  git_repo: null,
  environment: "production",
  release: null,
  input: null,
  output: null,
  metadata: null,
  spans: [],
};

function spanSelection(overrides: Partial<TraceSelection & { span: object }> = {}): TraceSelection {
  return {
    type: "span",
    span: {
      span_id: "span-456",
      trace_id: "trace-123",
      parent_span_id: null,
      name: "test-span",
      span_kind: "LLM",
      span_start_time: "2026-07-12T12:00:00Z",
      span_end_time: "2026-07-12T12:00:01Z",
      status: SpanStatus.ERROR,
      status_message: null,
      model_name: null,
      cost: null,
      input_tokens: null,
      output_tokens: null,
      total_tokens: null,
      git_source_file: null,
      git_source_line: null,
      git_source_function: null,
      ...(overrides as { span?: object }).span,
    },
  } as TraceSelection;
}

function spanIO(events: string | null): SpanIO {
  return {
    span_id: "span-456",
    trace_id: "trace-123",
    input: null,
    output: null,
    metadata: null,
    events,
  };
}

describe("SpanInfoPanel - exception error panel", () => {
  it("renders the error panel from the exception event when status_message is null (TS SDK case)", () => {
    mockSpanIO = spanIO(EXCEPTION_EVENTS_BLOB);
    render(<SpanInfoPanel projectId="proj-123" trace={trace} selection={spanSelection()} />);

    expect(screen.getByText("Error")).toBeTruthy();
    expect(screen.getByText("ZeroDivisionError: division by zero")).toBeTruthy();
    expect(screen.getByText(/File "\/app\/agents\/checkout\.py", line 42/)).toBeTruthy();
  });

  it("does not repeat the exception label when status_message already says it", () => {
    mockSpanIO = spanIO(EXCEPTION_EVENTS_BLOB);
    render(
      <SpanInfoPanel
        projectId="proj-123"
        trace={trace}
        selection={spanSelection({
          span: { status_message: "ZeroDivisionError: division by zero" },
        })}
      />,
    );

    // Exactly one occurrence: the status_message paragraph, no duplicate label.
    expect(screen.getAllByText("ZeroDivisionError: division by zero")).toHaveLength(1);
    // The stacktrace still renders — it is the part status_message cannot carry.
    expect(screen.getByText(/File "\/app\/agents\/checkout\.py", line 42/)).toBeTruthy();
  });

  it("renders no error panel for an OK span with a handled exception event", () => {
    mockSpanIO = spanIO(EXCEPTION_EVENTS_BLOB);
    render(
      <SpanInfoPanel
        projectId="proj-123"
        trace={trace}
        selection={spanSelection({ span: { status: SpanStatus.OK } })}
      />,
    );

    expect(screen.queryByText("Error")).toBeNull();
    // The handled exception is still auditable in the Events section.
    expect(screen.getByTestId("expandable-events (1)")).toBeTruthy();
  });

  it("renders no error panel for an ERROR span with neither message nor events (old rows)", () => {
    mockSpanIO = spanIO(null);
    render(<SpanInfoPanel projectId="proj-123" trace={trace} selection={spanSelection()} />);
    expect(screen.queryByText("Error")).toBeNull();
  });

  it("survives a malformed events blob", () => {
    mockSpanIO = spanIO("{not valid json");
    render(<SpanInfoPanel projectId="proj-123" trace={trace} selection={spanSelection()} />);
    expect(screen.queryByText("Error")).toBeNull();
    expect(screen.queryByTestId(/expandable-events/)).toBeNull();
  });
});

describe("SpanInfoPanel - events section", () => {
  it("lists events with name, and attributes for breadcrumbs", () => {
    mockSpanIO = spanIO(
      JSON.stringify([
        {
          name: "cache.miss",
          timestamp: "2026-07-12T12:00:00.100000",
          attributes: { "cache.key": "user:42" },
        },
        { name: "retry", timestamp: null, attributes: {} },
      ]),
    );
    render(
      <SpanInfoPanel
        projectId="proj-123"
        trace={trace}
        selection={spanSelection({ span: { status: SpanStatus.OK } })}
      />,
    );

    const section = screen.getByTestId("expandable-events (2)");
    expect(section).toBeTruthy();
    expect(screen.getByText("cache.miss")).toBeTruthy();
    expect(screen.getByText("retry")).toBeTruthy();
    expect(screen.getByText(/"cache\.key": "user:42"/)).toBeTruthy();
  });

  it("renders no events section when the span has no events", () => {
    mockSpanIO = spanIO(null);
    render(
      <SpanInfoPanel
        projectId="proj-123"
        trace={trace}
        selection={spanSelection({ span: { status: SpanStatus.OK } })}
      />,
    );
    expect(screen.queryByTestId(/expandable-events/)).toBeNull();
  });

  it("renders no events section for a trace selection", () => {
    mockSpanIO = spanIO(EXCEPTION_EVENTS_BLOB);
    render(
      <SpanInfoPanel
        projectId="proj-123"
        trace={trace}
        selection={{ type: "trace" } as TraceSelection}
      />,
    );
    expect(screen.queryByTestId(/expandable-events/)).toBeNull();
  });
});
