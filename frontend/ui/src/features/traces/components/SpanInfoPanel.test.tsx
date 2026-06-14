// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, cleanup, screen } from "@testing-library/react";
import { SpanKind, SpanStatus } from "@traceroot/core";
import type { Span, TraceDetail } from "@/types/api";

// ---------------------------------------------------------------------------
// Mocks — must be set up before any import of the module under test
// ---------------------------------------------------------------------------

const mockUseSpanIO = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: vi.fn(() => ({ push: vi.fn() })),
}));

vi.mock("../hooks", () => ({
  useSpanIO: (...args: unknown[]) => mockUseSpanIO(...args),
}));

vi.mock("@/components/ui/copy-button", () => ({
  CopyButton: () => null,
}));

vi.mock("./TokenChip", () => ({
  TokenChip: () => null,
}));

vi.mock("./CostChip", () => ({
  CostChip: () => null,
}));

vi.mock("./SpanKindIcon", () => ({
  SpanKindIcon: () => null,
}));

vi.mock("./ContentRenderer", () => ({
  ContentRenderer: () => null,
}));

vi.mock("@/components/ui/expandable-section", () => ({
  ExpandableSection: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

import { SpanInfoPanel, extractErrorSignal, findBestErrorDescendant } from "./SpanInfoPanel";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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
    git_source_file: null,
    git_source_line: null,
    git_source_function: null,
    ...overrides,
  };
}

function makeTrace(spans: Span[]): TraceDetail {
  return {
    trace_id: "trace-1",
    project_id: "proj-1",
    name: "test-trace",
    trace_start_time: "2024-01-01T00:00:00.000Z",
    user_id: null,
    session_id: null,
    git_ref: null,
    git_repo: null,
    environment: "test",
    release: null,
    input: null,
    output: null,
    metadata: null,
    spans,
  };
}

// ---------------------------------------------------------------------------
// Pure-function unit tests (no DOM required, but jsdom env is fine)
// ---------------------------------------------------------------------------

describe("extractErrorSignal", () => {
  it("returns null for null input", () => {
    expect(extractErrorSignal(null)).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(extractErrorSignal("")).toBeNull();
  });

  it("returns null for malformed JSON", () => {
    expect(extractErrorSignal("{not json}")).toBeNull();
  });

  it("returns null when no known error key is present", () => {
    expect(extractErrorSignal(JSON.stringify({ someOtherKey: "value" }))).toBeNull();
  });

  it("picks up exception.message as a string", () => {
    const metadata = JSON.stringify({ "exception.message": "something went wrong" });
    expect(extractErrorSignal(metadata)).toEqual({
      key: "exception.message",
      value: "something went wrong",
    });
  });

  it("picks up exception.type as a string", () => {
    const metadata = JSON.stringify({ "exception.type": "ValueError" });
    expect(extractErrorSignal(metadata)).toEqual({
      key: "exception.type",
      value: "ValueError",
    });
  });

  it("picks up error.message", () => {
    const metadata = JSON.stringify({ "error.message": "network timeout" });
    expect(extractErrorSignal(metadata)).toEqual({
      key: "error.message",
      value: "network timeout",
    });
  });

  it("picks up ai.response.finishReason", () => {
    const metadata = JSON.stringify({ "ai.response.finishReason": "content-filter" });
    expect(extractErrorSignal(metadata)).toEqual({
      key: "ai.response.finishReason",
      value: "content-filter",
    });
  });

  it("picks up first element of gen_ai.response.finish_reasons array", () => {
    const metadata = JSON.stringify({ "gen_ai.response.finish_reasons": ["content_filter"] });
    expect(extractErrorSignal(metadata)).toEqual({
      key: "gen_ai.response.finish_reasons",
      value: "content_filter",
    });
  });

  it("skips empty string values and returns null when all keys are empty", () => {
    const metadata = JSON.stringify({ "exception.message": "" });
    expect(extractErrorSignal(metadata)).toBeNull();
  });

  it("skips empty arrays", () => {
    const metadata = JSON.stringify({ "gen_ai.response.finish_reasons": [] });
    expect(extractErrorSignal(metadata)).toBeNull();
  });

  it("returns the first matching key in priority order", () => {
    const metadata = JSON.stringify({
      "ai.response.finishReason": "stop",
      "exception.message": "first wins",
    });
    expect(extractErrorSignal(metadata)).toEqual({
      key: "exception.message",
      value: "first wins",
    });
  });
});

describe("findBestErrorDescendant", () => {
  it("returns null when there are no spans at all", () => {
    expect(findBestErrorDescendant([], "root")).toBeNull();
  });

  it("returns null when root has no children", () => {
    const root = makeSpan({ span_id: "root" });
    expect(findBestErrorDescendant([root], "root")).toBeNull();
  });

  it("returns the only child when it exists", () => {
    const root = makeSpan({ span_id: "root" });
    const child = makeSpan({ span_id: "child", parent_span_id: "root" });
    expect(findBestErrorDescendant([root, child], "root")).toBe(child);
  });

  it("prefers a descendant with status_message over one without", () => {
    const root = makeSpan({ span_id: "root" });
    const plain = makeSpan({ span_id: "plain", parent_span_id: "root" });
    const withMsg = makeSpan({
      span_id: "with-msg",
      parent_span_id: "root",
      status_message: "boom",
    });
    const result = findBestErrorDescendant([root, plain, withMsg], "root");
    expect(result?.span_id).toBe("with-msg");
  });

  it("falls back to first descendant when none have status_message", () => {
    const root = makeSpan({ span_id: "root" });
    const a = makeSpan({ span_id: "a", parent_span_id: "root" });
    const b = makeSpan({ span_id: "b", parent_span_id: "root" });
    const result = findBestErrorDescendant([root, a, b], "root");
    expect(result?.span_id).toBe("a");
  });

  it("searches grandchildren (multi-level BFS)", () => {
    const root = makeSpan({ span_id: "root" });
    const child = makeSpan({ span_id: "child", parent_span_id: "root" });
    const grandchild = makeSpan({
      span_id: "grandchild",
      parent_span_id: "child",
      status_message: "deep error",
    });
    const result = findBestErrorDescendant([root, child, grandchild], "root");
    expect(result?.span_id).toBe("grandchild");
  });

  it("handles a cycle in parent_span_id without looping forever", () => {
    const a = makeSpan({ span_id: "a", parent_span_id: "b" });
    const b = makeSpan({ span_id: "b", parent_span_id: "a" });
    expect(() => findBestErrorDescendant([a, b], "a")).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Component render tests — verify the fallback error panel rendering
// ---------------------------------------------------------------------------

beforeEach(() => {
  mockUseSpanIO.mockReset();
  vi.stubGlobal("navigator", { clipboard: { writeText: vi.fn() } });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("SpanInfoPanel — fallback error signal", () => {
  it("shows nothing in the error panel when span has no error", () => {
    const span = makeSpan({ span_id: "s1" });
    const trace = makeTrace([span]);
    mockUseSpanIO.mockReturnValue({ data: undefined, isLoading: false });

    render(<SpanInfoPanel projectId="proj-1" trace={trace} selection={{ type: "span", span }} />);

    expect(screen.queryByText(/error/i)).toBeNull();
  });

  it("shows status_message directly when present", () => {
    const span = makeSpan({
      span_id: "s1",
      status: SpanStatus.ERROR,
      status_message: "direct error message",
    });
    const trace = makeTrace([span]);
    mockUseSpanIO.mockReturnValue({ data: undefined, isLoading: false });

    render(<SpanInfoPanel projectId="proj-1" trace={trace} selection={{ type: "span", span }} />);

    expect(screen.getByText("direct error message")).toBeDefined();
  });

  it("surfaces fallback signal from child metadata when status_message is null", () => {
    const parent = makeSpan({ span_id: "parent", status: SpanStatus.ERROR });
    const child = makeSpan({ span_id: "child-1", name: "child-span", parent_span_id: "parent" });
    const trace = makeTrace([parent, child]);

    mockUseSpanIO.mockImplementation(
      (_projectId: string, _traceId: string, spanId: string | null) => {
        if (spanId === "child-1") {
          return {
            data: {
              span_id: "child-1",
              trace_id: "trace-1",
              input: null,
              output: null,
              metadata: JSON.stringify({ "exception.message": "content-filter blocked request" }),
            },
            isLoading: false,
          };
        }
        return { data: undefined, isLoading: false };
      },
    );

    render(
      <SpanInfoPanel projectId="proj-1" trace={trace} selection={{ type: "span", span: parent }} />,
    );

    expect(screen.getByText("content-filter blocked request")).toBeDefined();
    expect(screen.getByText(/from "child-span"/)).toBeDefined();
    expect(screen.getByText(/exception\.message/)).toBeDefined();
  });

  it("surfaces status_message from child span when child has one", () => {
    const parent = makeSpan({ span_id: "parent", status: SpanStatus.ERROR });
    const child = makeSpan({
      span_id: "child-1",
      name: "inner",
      parent_span_id: "parent",
      status_message: "inner failure",
    });
    const trace = makeTrace([parent, child]);

    mockUseSpanIO.mockReturnValue({ data: undefined, isLoading: false });

    render(
      <SpanInfoPanel projectId="proj-1" trace={trace} selection={{ type: "span", span: parent }} />,
    );

    expect(screen.getByText("inner failure")).toBeDefined();
    expect(screen.getByText(/from "inner"/)).toBeDefined();
  });

  it("shows the 'descendant span' note only for fallback signals", () => {
    const parent = makeSpan({ span_id: "parent", status: SpanStatus.ERROR });
    const child = makeSpan({ span_id: "child-1", parent_span_id: "parent" });
    const trace = makeTrace([parent, child]);

    mockUseSpanIO.mockImplementation(
      (_projectId: string, _traceId: string, spanId: string | null) => {
        if (spanId === "child-1") {
          return {
            data: {
              span_id: "child-1",
              trace_id: "trace-1",
              input: null,
              output: null,
              metadata: JSON.stringify({ "error.type": "RuntimeError" }),
            },
            isLoading: false,
          };
        }
        return { data: undefined, isLoading: false };
      },
    );

    render(
      <SpanInfoPanel projectId="proj-1" trace={trace} selection={{ type: "span", span: parent }} />,
    );

    expect(screen.getByText(/closest failure signal from a descendant/)).toBeDefined();
  });
});
