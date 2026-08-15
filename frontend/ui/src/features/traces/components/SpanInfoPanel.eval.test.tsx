// @vitest-environment jsdom
/**
 * Render coverage for the span detail panel and the metric chips it composes
 * (TokenChip / CostChip / MetricDelta), across the trace selection, a span
 * selection, the error state and diff mode.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, cleanup, screen, fireEvent } from "@testing-library/react";
import { SpanStatus } from "@traceroot/core";
import type { Span, SpanIO, TraceDetail } from "@/types/api";

const push = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push, replace: vi.fn() }),
}));

// Per-span I/O is a lazy fetch in production; serve it from a fixture map keyed
// by span id so the panel's fetched-vs-inline fallbacks are both exercised.
const ioMocks = vi.hoisted(() => ({
  byId: new Map<string, Partial<SpanIO>>(),
  loading: false,
}));
vi.mock("../hooks", () => ({
  useSpanIO: (_p: string, _t: string, spanId: string | null) => ({
    data: spanId ? ioMocks.byId.get(spanId) : undefined,
    isLoading: spanId ? ioMocks.loading : false,
  }),
}));

import { SpanInfoPanel } from "./SpanInfoPanel";
import { MetricDelta } from "./MetricDelta";
import { CostChip } from "./CostChip";
import { TokenChip } from "./TokenChip";

function makeSpan(overrides: Partial<Span> = {}): Span {
  return {
    span_id: "span-1",
    trace_id: "trace-1",
    parent_span_id: null,
    name: "root span",
    span_kind: "LLM",
    span_start_time: "2026-07-17T10:24:00.000Z",
    span_end_time: "2026-07-17T10:24:02.500Z",
    status: SpanStatus.OK,
    status_message: null,
    model_name: "claude-opus-5",
    cost: 0.012345,
    input_tokens: 1200,
    output_tokens: 300,
    total_tokens: 1500,
    usage_details: { cache_read_tokens: 100, cache_write_tokens: 50, reasoning_tokens: 25 },
    cost_details: {
      input_uncached_cost: 0.004,
      cache_read_cost: 0.001,
      cache_write_cost: 0.002,
      output_cost: 0.005345,
    },
    input: '{"prompt":"hi"}',
    output: '{"reply":"hello"}',
    metadata: '{"user":"ada","traceroot.span.kind":"LLM"}',
    git_source_file: "app/agent.py",
    git_source_line: 42,
    git_source_function: "run",
    ...overrides,
  };
}

function makeTrace(overrides: Partial<TraceDetail> = {}): TraceDetail {
  return {
    trace_id: "trace-1",
    project_id: "proj-1",
    name: "billing routing",
    trace_start_time: "2026-07-17T10:24:00.000Z",
    user_id: "user-7",
    session_id: "sess-9",
    git_ref: "4a91c02deadbeef",
    git_repo: "traceroot-ai/traceroot",
    environment: "production",
    release: null,
    input: '{"question":"why was I charged twice"}',
    output: '{"answer":"billing"}',
    metadata: '{"tier":"pro","traceroot.span.internal":"x"}',
    spans: [makeSpan()],
    ...overrides,
  };
}

function renderPanel(props: Partial<React.ComponentProps<typeof SpanInfoPanel>> = {}) {
  return render(
    <SpanInfoPanel
      projectId="proj-1"
      trace={makeTrace()}
      selection={{ type: "trace" }}
      {...props}
    />,
  );
}

beforeEach(() => {
  ioMocks.byId.clear();
  ioMocks.loading = false;
  push.mockReset();
});
afterEach(() => cleanup());

describe("SpanInfoPanel — trace selection", () => {
  it("renders the trace header, aggregates and git/user/session rows", () => {
    renderPanel();
    expect(screen.getByText("billing routing")).toBeTruthy();
    expect(screen.getByText("trace")).toBeTruthy(); // span-kind chip, lowercased
    expect(screen.getByText("Latency:")).toBeTruthy();
    expect(screen.getByText("production")).toBeTruthy();
    // Token rollup chip (input → output (total)) and the summed cost chip.
    expect(screen.getByText(/→/)).toBeTruthy();
    expect(screen.getByText("0.012345")).toBeTruthy();
    expect(screen.getByText("traceroot-ai/traceroot")).toBeTruthy();
    expect(screen.getByText("4a91c02")).toBeTruthy();
    expect(screen.getByText("user-7")).toBeTruthy();
    expect(screen.getByText("sess-9")).toBeTruthy();
  });

  it("links the git repo and commit to GitHub", () => {
    const { container } = renderPanel();
    const links = Array.from(container.querySelectorAll("a")).map((a) => a.getAttribute("href"));
    expect(links).toContain("https://github.com/traceroot-ai/traceroot");
    expect(links).toContain("https://github.com/traceroot-ai/traceroot/commit/4a91c02deadbeef");
  });

  it("leaves the ref link hrefless when there is no repo", () => {
    const { container } = renderPanel({ trace: makeTrace({ git_repo: null }) });
    const ref = Array.from(container.querySelectorAll("a")).find((a) =>
      a.textContent?.includes("4a91c02"),
    );
    expect(ref).toBeTruthy();
    expect(ref?.getAttribute("href")).toBeNull();
  });

  it("navigates to the filtered traces list from the user chip", () => {
    const onClose = vi.fn();
    renderPanel({ onClose });
    fireEvent.click(screen.getByText("user-7").closest("button")!);
    expect(onClose).toHaveBeenCalled();
    expect(push).toHaveBeenCalledWith(expect.stringContaining("/projects/proj-1/traces"));
    expect(push.mock.calls[0][0]).toContain("user_id=user-7");
  });

  it("navigates to the session from the session chip", () => {
    renderPanel();
    fireEvent.click(screen.getByText("sess-9").closest("button")!);
    expect(push).toHaveBeenCalledWith(expect.stringContaining("/projects/proj-1/sessions"));
    expect(push.mock.calls[0][0]).toContain("sessionId=sess-9");
  });

  it("strips traceroot.span.* keys from the metadata section", () => {
    const { container } = renderPanel();
    expect(container.textContent).toContain("tier");
    expect(container.textContent).not.toContain("traceroot.span.internal");
  });

  it("passes non-JSON metadata through untouched", () => {
    const { container } = renderPanel({ trace: makeTrace({ metadata: "not json at all" }) });
    expect(container.textContent).toContain("not json at all");
  });

  it("omits the git and user rows when the trace carries none", () => {
    renderPanel({
      trace: makeTrace({ git_ref: null, git_repo: null, user_id: null, session_id: null }),
    });
    expect(screen.queryByText("Repo:")).toBeNull();
    expect(screen.queryByText("User:")).toBeNull();
    expect(screen.queryByText("Session:")).toBeNull();
  });

  it("hides the token and cost chips when no span reports them", () => {
    renderPanel({
      trace: makeTrace({
        spans: [makeSpan({ total_tokens: null, cost: null, cost_details: undefined })],
      }),
    });
    expect(screen.queryByText("0.012345")).toBeNull();
  });

  it("renders the injected offline-eval slots", () => {
    renderPanel({
      spanActions: <button type="button">Save as test case</button>,
      headerAction: <span>header-action</span>,
      extraTags: <span>Dataset: billing</span>,
    });
    expect(screen.getByText("Save as test case")).toBeTruthy();
    expect(screen.getByText("header-action")).toBeTruthy();
    expect(screen.getByText("Dataset: billing")).toBeTruthy();
  });
});

describe("SpanInfoPanel — span selection", () => {
  it("renders per-span model, tokens and cost from the lazy I/O fetch", () => {
    ioMocks.byId.set("span-1", {
      input: "fetched input",
      output: "fetched output",
      metadata: '{"fetched":"yes"}',
    });
    const { container } = renderPanel({ selection: { type: "span", span: makeSpan() } });
    expect(screen.getByText("claude-opus-5")).toBeTruthy();
    expect(screen.getByText("llm")).toBeTruthy();
    expect(container.textContent).toContain("fetched input");
    expect(container.textContent).toContain("fetched output");
    expect(container.textContent).toContain("fetched");
  });

  it("falls back to the span's own I/O when the fetch returns nothing", () => {
    const { container } = renderPanel({ selection: { type: "span", span: makeSpan() } });
    expect(container.textContent).toContain("prompt");
    expect(container.textContent).toContain("reply");
  });

  it("shows the loading state while span I/O is in flight", () => {
    ioMocks.loading = true;
    renderPanel({ selection: { type: "span", span: makeSpan() } });
    expect(screen.getAllByText("Loading…").length).toBeGreaterThan(0);
  });

  it("renders the ERROR badge, message and source location", () => {
    const span = makeSpan({
      status: SpanStatus.ERROR,
      status_message: "RateLimitError: slow down",
    });
    const { container } = renderPanel({ selection: { type: "span", span } });
    expect(screen.getByText("ERROR")).toBeTruthy();
    expect(screen.getByText("RateLimitError: slow down")).toBeTruthy();
    expect(container.textContent).toContain("app/agent.py:42");
  });

  it("renders the error block without a source file", () => {
    const span = makeSpan({
      status: SpanStatus.ERROR,
      status_message: "boom",
      git_source_file: null,
      git_source_line: null,
    });
    renderPanel({
      trace: makeTrace({ git_repo: null, git_ref: null }),
      selection: { type: "span", span },
    });
    expect(screen.getByText("boom")).toBeTruthy();
  });

  it("omits the token chip when the span has no token counts", () => {
    const span = makeSpan({ total_tokens: null, model_name: null });
    renderPanel({ selection: { type: "span", span } });
    expect(screen.queryByText("claude-opus-5")).toBeNull();
  });
});

describe("SpanInfoPanel — diff mode", () => {
  const baselineSpan = makeSpan({
    span_id: "span-0",
    trace_id: "trace-0",
    span_end_time: "2026-07-17T10:24:01.000Z",
    cost: 0.01,
    total_tokens: 1000,
    input_tokens: 800,
    output_tokens: 200,
    input: '{"prompt":"hi there"}',
    output: '{"reply":"hey"}',
    metadata: '{"user":"grace"}',
    cost_details: { input_uncached_cost: 0.006, output_cost: 0.004 },
  });

  it("renders line diffs and ± deltas for a span selection", () => {
    const { container } = renderPanel({
      selection: { type: "span", span: makeSpan() },
      diffMode: true,
      baselineSpan,
    });
    // The diff header markers replace the plain format switcher.
    expect(screen.getAllByText("− baseline").length).toBeGreaterThan(0);
    expect(screen.getAllByText("+ candidate").length).toBeGreaterThan(0);
    // Positive (worse) deltas render in red with a leading "+".
    expect(container.querySelector(".text-red-600")).toBeTruthy();
  });

  it("renders trace-level diffs against a baseline trace", () => {
    const baselineTrace = makeTrace({
      trace_id: "trace-0",
      input: '{"question":"why the charge"}',
      output: '{"answer":"support"}',
      metadata: '{"tier":"free"}',
      spans: [baselineSpan],
    });
    const { container } = renderPanel({
      diffMode: true,
      baselineTrace,
    });
    expect(screen.getAllByText("− baseline").length).toBeGreaterThan(0);
    expect(container.textContent).toContain("Metadata");
  });

  it("stays in the plain (non-diff) view when no baseline is supplied", () => {
    renderPanel({ diffMode: true, baselineSpan: null, baselineTrace: null });
    expect(screen.queryByText("− baseline")).toBeNull();
  });

  it("renders an unchanged marker when candidate and baseline match", () => {
    const same = makeSpan({ span_id: "span-0", trace_id: "trace-0" });
    renderPanel({
      selection: { type: "span", span: makeSpan() },
      diffMode: true,
      baselineSpan: same,
    });
    expect(screen.getAllByText("unchanged").length).toBeGreaterThan(0);
  });

  it("skips the token/cost deltas when the candidate span has no counts", () => {
    renderPanel({
      selection: {
        type: "span",
        span: makeSpan({ total_tokens: null, cost: null }),
      },
      diffMode: true,
      baselineSpan,
    });
    expect(screen.getAllByText("− baseline").length).toBeGreaterThan(0);
  });

  it("reads baseline span I/O from the lazy fetch when present", () => {
    ioMocks.byId.set("span-0", { input: "baseline fetched", output: null, metadata: null });
    const { container } = renderPanel({
      selection: { type: "span", span: makeSpan() },
      diffMode: true,
      baselineSpan,
    });
    expect(container.textContent).toContain("baseline fetched");
  });
});

describe("MetricDelta", () => {
  const fmt = (n: number) => n.toFixed(1);

  it("renders nothing without a delta", () => {
    const { container } = render(<MetricDelta delta={null} format={fmt} />);
    expect(container.innerHTML).toBe("");
  });

  it("renders nothing for a non-finite delta", () => {
    const { container } = render(<MetricDelta delta={Number.NaN} format={fmt} />);
    expect(container.innerHTML).toBe("");
  });

  it("renders a muted ±0 when unchanged", () => {
    render(<MetricDelta delta={0} format={fmt} />);
    const el = screen.getByText("±0");
    expect(el.className).toContain("text-muted-foreground");
  });

  it("renders a red + for a worse (higher) value", () => {
    const { container } = render(<MetricDelta delta={2.5} format={fmt} />);
    expect(container.textContent).toBe("+2.5");
    expect(container.firstElementChild?.className).toContain("text-red-600");
  });

  it("renders a green true-minus for a better (lower) value", () => {
    const { container } = render(<MetricDelta delta={-2.5} format={fmt} />);
    expect(container.textContent).toBe("−2.5");
    expect(container.firstElementChild?.className).toContain("text-emerald-600");
  });
});

describe("CostChip", () => {
  it("renders nothing without a cost", () => {
    const { container } = render(<CostChip cost={null} />);
    expect(container.innerHTML).toBe("");
  });

  it("renders nothing for a non-finite cost", () => {
    const { container } = render(<CostChip cost={Number.POSITIVE_INFINITY} />);
    expect(container.innerHTML).toBe("");
  });

  it("renders a plain chip when there is no breakdown", () => {
    render(<CostChip cost={0.5} costDetails={{}} />);
    expect(screen.getByText("0.500000")).toBeTruthy();
  });

  it("renders a tooltip-wrapped chip when a breakdown exists", () => {
    render(<CostChip cost={0.5} costDetails={{ output_cost: 0.5 }} delta={<span>+0.1</span>} />);
    expect(screen.getByText("0.500000")).toBeTruthy();
    expect(screen.getByText("+0.1")).toBeTruthy();
  });

  it("renders the tooltip wrapper when only the baseline has a breakdown", () => {
    render(<CostChip cost={0.5} costDetails={null} baselineDetails={{ output_cost: 0.4 }} />);
    expect(screen.getByText("0.500000")).toBeTruthy();
  });
});

describe("TokenChip", () => {
  it("renders the token flow with a delta suffix", () => {
    render(
      <TokenChip
        inputTokens={100}
        outputTokens={20}
        totalTokens={120}
        cacheReadTokens={5}
        cacheWriteTokens={2}
        reasoningTokens={1}
        delta={<span>+10</span>}
      />,
    );
    expect(screen.getByText("+10")).toBeTruthy();
    expect(screen.getByText(/120/)).toBeTruthy();
  });

  it("renders with unknown input/output counts", () => {
    const { container } = render(
      <TokenChip inputTokens={null} outputTokens={null} totalTokens={42} />,
    );
    expect(container.textContent).toContain("42");
  });
});
