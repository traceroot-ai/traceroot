// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, cleanup, screen } from "@testing-library/react";
import React from "react";
import { SpanStatus } from "@traceroot/core";
import { SpanInfoPanel } from "./SpanInfoPanel";
import type { TraceDetail } from "@/types/api";
import type { TraceSelection } from "../types";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

const mockUseSpanIO = vi.fn(() => ({ data: null as unknown, isLoading: false }));
vi.mock("../hooks", () => ({
  useSpanIO: () => mockUseSpanIO(),
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
  ContentRenderer: ({ content }: { content: string | null }) => (
    <div data-testid="content-renderer">{content}</div>
  ),
}));

vi.mock("./SpanKindIcon", () => ({
  SpanKindIcon: () => <div data-testid="span-kind-icon" />,
}));

afterEach(() => {
  cleanup();
  mockUseSpanIO.mockReset().mockReturnValue({ data: null, isLoading: false });
});

describe("SpanInfoPanel - Error box source location badges", () => {
  const mockTrace: TraceDetail = {
    trace_id: "trace-123",
    project_id: "proj-123",
    name: "test-trace",
    trace_start_time: "2026-07-12T12:00:00Z",
    user_id: null,
    session_id: null,
    git_ref: "a1b2c3d4e5f6g7h8i9j0",
    git_repo: "github.com/org-name/a-very-long-monorepo-name-example",
    environment: "production",
    release: null,
    input: null,
    output: null,
    metadata: null,
    spans: [],
  };

  const mockSelection: TraceSelection = {
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
      status_message: "Traceback (most recent call last): ...",
      model_name: "gpt-4o",
      cost: 0.005,
      input_tokens: 150,
      output_tokens: 250,
      total_tokens: 400,
      git_source_file:
        "/opt/homebrew/Cellar/python@3.14/3.14.6/Frameworks/Python.framework/Versions/3.14/lib/python3.14/asyncio/events.py",
      git_source_line: 123,
      git_source_function: "run",
    },
  };

  it("renders Error box with git_repo, git_source_file, and git_ref badges", () => {
    render(<SpanInfoPanel projectId="proj-123" trace={mockTrace} selection={mockSelection} />);

    // 1. Verify git_repo badge wrapping styles
    const repoSpan = screen.getByText("github.com/org-name/a-very-long-monorepo-name-example");
    expect(repoSpan).toBeTruthy();
    expect(repoSpan.className).toContain("min-w-0");
    expect(repoSpan.className).toContain("break-all");

    const repoParentDiv = repoSpan.parentElement;
    expect(repoParentDiv).toBeTruthy();
    expect(repoParentDiv?.className).toContain("inline-flex");
    expect(repoParentDiv?.className).toContain("min-w-0");

    const repoIcon = repoParentDiv?.querySelector("svg");
    expect(repoIcon).toBeTruthy();
    expect(repoIcon?.getAttribute("class")).toContain("shrink-0");

    // 2. Verify git_source_file badge wrapping styles
    const expectedFilePath =
      "/opt/homebrew/Cellar/python@3.14/3.14.6/Frameworks/Python.framework/Versions/3.14/lib/python3.14/asyncio/events.py:123";
    const fileSpan = screen.getByText((content, element) => {
      const text = element?.textContent || "";
      return (
        text.replace(/\s+/g, "") === expectedFilePath.replace(/\s+/g, "") &&
        element?.tagName.toLowerCase() === "span"
      );
    });
    expect(fileSpan).toBeTruthy();
    expect(fileSpan.className).toContain("min-w-0");
    expect(fileSpan.className).toContain("break-all");

    const fileParentDiv = fileSpan.parentElement;
    expect(fileParentDiv).toBeTruthy();
    expect(fileParentDiv?.className).toContain("inline-flex");
    expect(fileParentDiv?.className).toContain("min-w-0");

    const fileIcon = fileParentDiv?.querySelector("svg");
    expect(fileIcon).toBeTruthy();
    expect(fileIcon?.getAttribute("class")).toContain("shrink-0");

    // 3. Verify git_ref badge is NOT affected (no min-w-0, no break-all on span or parent)
    const refSpan = screen.getByText("a1b2c3d");
    expect(refSpan).toBeTruthy();
    expect(refSpan.className).not.toContain("min-w-0");
    expect(refSpan.className).not.toContain("break-all");

    const refParentDiv = refSpan.parentElement;
    expect(refParentDiv).toBeTruthy();
    expect(refParentDiv?.className).toContain("inline-flex");
    expect(refParentDiv?.className).not.toContain("min-w-0");

    const refIcon = refParentDiv?.querySelector("svg");
    expect(refIcon).toBeTruthy();
    expect(refIcon?.getAttribute("class")).toContain("shrink-0");

    // 4. Verify the sibling error message text is rendered
    const errorMessage = screen.getByText("Traceback (most recent call last): ...");
    expect(errorMessage).toBeTruthy();
    expect(errorMessage.className).toContain("whitespace-pre-wrap");
    expect(errorMessage.className).toContain("break-all");
  });

  it("renders the model_name pill with its icon", () => {
    render(<SpanInfoPanel projectId="proj-123" trace={mockTrace} selection={mockSelection} />);

    const modelPill = screen.getByText("gpt-4o");
    expect(modelPill).toBeTruthy();

    const modelIcon = modelPill.querySelector("svg");
    expect(modelIcon).toBeTruthy();
  });

  it("renders Trace header with git_repo and git_ref badges with correct wrapping styles", () => {
    const mockTraceSelection: TraceSelection = {
      type: "trace",
    };

    render(<SpanInfoPanel projectId="proj-123" trace={mockTrace} selection={mockTraceSelection} />);

    // Verify header git_repo badge wrapping styles
    const repoSpan = screen.getByText("github.com/org-name/a-very-long-monorepo-name-example");
    expect(repoSpan).toBeTruthy();
    expect(repoSpan.className).toContain("min-w-0");
    expect(repoSpan.className).toContain("break-all");

    const repoParentLink = repoSpan.parentElement;
    expect(repoParentLink).toBeTruthy();
    expect(repoParentLink?.tagName.toLowerCase()).toBe("a");
    expect(repoParentLink?.className).toContain("inline-flex");
    expect(repoParentLink?.className).toContain("min-w-0");

    const headerRepoIcon = repoParentLink?.querySelector("svg");
    expect(headerRepoIcon).toBeTruthy();
    expect(headerRepoIcon?.getAttribute("class")).toContain("shrink-0");

    const headerRepoLabel = screen.getByText("Repo:");
    expect(headerRepoLabel).toBeTruthy();
    expect(headerRepoLabel.className).toContain("shrink-0");

    // Verify header git_ref badge is NOT affected (no min-w-0, no break-all on span or parent)
    const refSpan = screen.getByText("a1b2c3d");
    expect(refSpan).toBeTruthy();
    expect(refSpan.className).not.toContain("min-w-0");
    expect(refSpan.className).not.toContain("break-all");

    const refParentLink = refSpan.parentElement;
    expect(refParentLink).toBeTruthy();
    expect(refParentLink?.tagName.toLowerCase()).toBe("a");
    expect(refParentLink?.className).toContain("inline-flex");
    expect(refParentLink?.className).not.toContain("min-w-0");

    const headerRefIcon = refParentLink?.querySelector("svg");
    expect(headerRefIcon).toBeTruthy();
    expect(headerRefIcon?.getAttribute("class")).toContain("shrink-0");

    const headerRefLabel = screen.getByText("Ref:");
    expect(headerRefLabel).toBeTruthy();
    expect(headerRefLabel.className).toContain("shrink-0");
  });

  it("renders User and Session link badges when the trace has both ids", () => {
    const traceWithIds: TraceDetail = { ...mockTrace, user_id: "user-42", session_id: "session-7" };
    const mockTraceSelection: TraceSelection = { type: "trace" };

    render(
      <SpanInfoPanel projectId="proj-123" trace={traceWithIds} selection={mockTraceSelection} />,
    );

    expect(screen.getByText("User:")).toBeTruthy();
    expect(screen.getByText("user-42")).toBeTruthy();
    expect(screen.getByText("Session:")).toBeTruthy();
    expect(screen.getByText("session-7")).toBeTruthy();
  });
});

describe("SpanInfoPanel - eval-shaped reconstructed trace", () => {
  const mockTrace: TraceDetail = {
    trace_id: "eval-result-1",
    project_id: "eval-1",
    name: "eval trace",
    trace_start_time: "2026-07-12T12:00:00Z",
    user_id: null,
    session_id: null,
    git_ref: null,
    git_repo: null,
    environment: "evaluation",
    release: null,
    input: null,
    output: null,
    metadata: null,
    spans: [],
  };

  const evalSpanSelection: TraceSelection = {
    type: "span",
    span: {
      span_id: "eval-result-1-task",
      trace_id: "eval-result-1",
      parent_span_id: "eval-result-1-root",
      name: "task",
      span_kind: "SPAN",
      span_start_time: "1970-01-01T00:00:00.000Z",
      span_end_time: "1970-01-01T00:00:00.001Z",
      status: SpanStatus.OK,
      status_message: null,
      model_name: null,
      // Non-null cost/tokens so the token/cost chips would render if they weren't
      // gated on isEvalShaped (they'd otherwise also self-gate on these being null,
      // which wouldn't prove the gating itself works).
      cost: 0.0025,
      input_tokens: 10,
      output_tokens: 20,
      total_tokens: 30,
      input: "the seeded input",
      output: "the seeded output",
      metadata: JSON.stringify({ step: "task" }),
      git_source_file: null,
      git_source_line: null,
      git_source_function: null,
    },
  };

  it("falls back to the span's own input/output/metadata when the span-IO fetch is empty", () => {
    // The lazy /span-io fetch has resolved with nothing (as for a synthetic span
    // id with no ClickHouse row), so the panel must fall back to the span object.
    mockUseSpanIO.mockReturnValue({ data: null, isLoading: false });

    render(<SpanInfoPanel projectId="eval-1" trace={mockTrace} selection={evalSpanSelection} />);

    expect(screen.getByText("the seeded input")).toBeTruthy();
    expect(screen.getByText("the seeded output")).toBeTruthy();
    expect(screen.getByText(JSON.stringify({ step: "task" }))).toBeTruthy();
  });

  it("hides the span-level duration/token/cost badges and shows I/O only when isEvalShaped", () => {
    render(
      <SpanInfoPanel
        projectId="eval-1"
        trace={mockTrace}
        selection={evalSpanSelection}
        isEvalShaped
      />,
    );

    expect(screen.queryByText("Latency:")).toBeNull();
    // Token/cost are non-null on this span (so they'd render if not gated —
    // otherwise this would pass even without the isEvalShaped fix).
    expect(screen.queryByText("10 → 20 (30)")).toBeNull();
    expect(screen.queryByText("0.002500")).toBeNull();
    expect(screen.getByTestId("expandable-input")).toBeTruthy();
    expect(screen.getByTestId("expandable-output")).toBeTruthy();
    expect(screen.getByTestId("expandable-metadata")).toBeTruthy();
  });

  it("hides the trace-level duration/token/cost/git badges when isEvalShaped", () => {
    const traceWithMetrics: TraceDetail = {
      ...mockTrace,
      git_ref: "a1b2c3d4e5f6",
      git_repo: "github.com/org/eval-repo",
      spans: [
        {
          span_id: "eval-result-1-task",
          trace_id: "eval-result-1",
          parent_span_id: null,
          name: "task",
          span_kind: "SPAN",
          span_start_time: "1970-01-01T00:00:00.000Z",
          span_end_time: "1970-01-01T00:00:00.001Z",
          status: SpanStatus.OK,
          status_message: null,
          model_name: null,
          cost: 0.0025,
          input_tokens: 10,
          output_tokens: 20,
          total_tokens: 30,
          input: null,
          output: null,
          metadata: null,
          git_source_file: null,
          git_source_line: null,
          git_source_function: null,
        },
      ],
    };

    render(
      <SpanInfoPanel
        projectId="eval-1"
        trace={traceWithMetrics}
        selection={{ type: "trace" }}
        isEvalShaped
      />,
    );

    expect(screen.queryByText("Latency:")).toBeNull();
    expect(screen.queryByText("10 → 20 (30)")).toBeNull();
    expect(screen.queryByText("0.002500")).toBeNull();
    expect(screen.queryByText("Repo:")).toBeNull();
    expect(screen.queryByText("Ref:")).toBeNull();
  });

  it("still shows the latency badge when isEvalShaped is not set (real trace)", () => {
    const realTrace: TraceDetail = { ...mockTrace, environment: "production" };
    render(<SpanInfoPanel projectId="eval-1" trace={realTrace} selection={evalSpanSelection} />);

    expect(screen.getByText("Latency:")).toBeTruthy();
  });
});
