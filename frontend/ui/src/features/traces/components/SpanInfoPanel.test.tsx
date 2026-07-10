// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { SpanKind, SpanStatus } from "@traceroot/core";
import type { Span, TraceDetail } from "@/types/api";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("../hooks", () => ({
  useSpanIO: () => ({
    data: { input: "span-in", output: "span-out", metadata: "{}" },
    isLoading: false,
  }),
}));
// Heavy renderers stubbed — this suite covers the panel's own derivation
// (duration + trace aggregates), not the content viewers.
vi.mock("./ContentRenderer", () => ({
  ContentRenderer: ({ content }: { content: string | null }) => (
    <div data-testid="content">{content ?? "-"}</div>
  ),
}));
vi.mock("./TokenChip", () => ({ TokenChip: () => <div data-testid="token-chip" /> }));
vi.mock("./CostChip", () => ({ CostChip: () => <div data-testid="cost-chip" /> }));

import { SpanInfoPanel } from "./SpanInfoPanel";

// Minimal span factory — only fields the info panel reads.
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

const llmSpan = makeSpan({
  span_id: "llm",
  name: "llm_call",
  parent_span_id: "root",
  span_kind: SpanKind.LLM,
  span_start_time: "2024-01-01T00:00:01.000Z",
  span_end_time: "2024-01-01T00:00:05.000Z",
  input_tokens: 1000,
  output_tokens: 500,
  total_tokens: 1500,
  cost: 0.0123,
});

const trace = {
  trace_id: "t1",
  project_id: "p1",
  name: "demo-trace",
  trace_start_time: "2024-01-01T00:00:00.000Z",
  input: '{"q":"hi"}',
  output: '{"a":"ok"}',
  metadata: "{}",
  user_id: null,
  session_id: null,
  git_ref: null,
  git_repo: null,
  spans: [
    makeSpan({
      span_id: "root",
      name: "root_span",
      span_start_time: "2024-01-01T00:00:00.000Z",
      span_end_time: "2024-01-01T00:00:10.000Z",
    }),
    llmSpan,
  ],
} as unknown as TraceDetail;

afterEach(() => cleanup());

describe("SpanInfoPanel", () => {
  it("shows trace-level duration and aggregate chips for a trace selection", () => {
    render(<SpanInfoPanel projectId="p1" trace={trace} selection={{ type: "trace" }} />);
    expect(screen.getByText("demo-trace")).toBeTruthy();
    // getTraceDuration over the fixture: 10s extent
    expect(screen.getByText("10.0s")).toBeTruthy();
    // Aggregates render through the (stubbed) chips
    expect(screen.getByTestId("token-chip")).toBeTruthy();
    expect(screen.getByTestId("cost-chip")).toBeTruthy();
  });

  it("shows the span's own duration and lazy-fetched I/O for a span selection", () => {
    render(
      <SpanInfoPanel projectId="p1" trace={trace} selection={{ type: "span", span: llmSpan }} />,
    );
    expect(screen.getByText("llm_call")).toBeTruthy();
    // getSpanDuration(llmSpan): 4s
    expect(screen.getByText("4.0s")).toBeTruthy();
    // Lazy span I/O flows through the content renderer
    expect(screen.getAllByTestId("content").some((n) => n.textContent === "span-in")).toBe(true);
  });
});
