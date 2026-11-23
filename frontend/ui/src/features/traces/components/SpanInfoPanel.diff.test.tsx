// @vitest-environment jsdom
/**
 * The span detail panel in diff mode: the selected span compared with its counterpart in a
 * baseline trace of the same case. The chips read before → after and say how the span
 * was paired; Input, Output and Metadata stay in their boxes with a diff for a body; a span
 * only one run has shows that run's values; the trace root shows the host's case.
 */
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { SpanKind, SpanStatus } from "@traceroot/core";
import { traceUnion, type UnionNode } from "@/lib/eval/union-tree";
import type { Span, SpanIO, TraceDetail } from "@/types/api";
import type { TraceSelection } from "../types";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
// Span I/O is fetched per trace and span; the fixture map is keyed "traceId/spanId".
const io = vi.hoisted(() => ({
  byKey: new Map<string, Partial<SpanIO>>(),
  calls: [] as string[],
}));
vi.mock("../hooks", () => ({
  useSpanIO: (_p: string, traceId: string, spanId: string | null) => {
    if (spanId) io.calls.push(`${traceId}/${spanId}`);
    return { data: spanId ? io.byKey.get(`${traceId}/${spanId}`) : undefined, isLoading: false };
  },
}));

import { SpanInfoPanel } from "./SpanInfoPanel";
import type { SpanInfoDiff } from "./SpanDiffDetail";

const T0 = Date.UTC(2026, 10, 1, 10);
const at = (ms: number) => new Date(T0 + ms).toISOString();

type Row = [
  id: string,
  parent: string | null,
  name: string,
  kind: Span["span_kind"],
  start: number,
  end: number,
  extra?: Partial<Span>,
];

function traceOf(traceId: string, rows: Row[], extra: Partial<TraceDetail> = {}): TraceDetail {
  return {
    trace_id: traceId,
    project_id: "p1",
    name: "agent",
    trace_start_time: at(0),
    user_id: null,
    session_id: null,
    git_ref: null,
    git_repo: null,
    environment: "production",
    release: null,
    input: null,
    output: null,
    metadata: null,
    spans: rows.map(([span_id, parent_span_id, name, span_kind, start, end, more]) => ({
      span_id,
      trace_id: traceId,
      parent_span_id,
      name,
      span_kind,
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
      ...more,
    })),
    ...extra,
  };
}

// The candidate plans on another model, slower and with more tokens, and answers where the
// baseline searched.
const BASELINE = traceOf(
  "tb",
  [
    ["b0", null, "agent", SpanKind.AGENT, 0, 1000],
    [
      "b1",
      "b0",
      "plan",
      SpanKind.LLM,
      10,
      100,
      { total_tokens: 100, cost: 0.001, model_name: "gpt-4o" },
    ],
    ["b2", "b0", "web_search", SpanKind.TOOL, 110, 200],
  ],
  { input: '"Explain the refund window."', output: '"Refunds within 14 days."' },
);
const CANDIDATE = traceOf(
  "tc",
  [
    ["c0", null, "agent", SpanKind.AGENT, 0, 1600],
    [
      "c1",
      "c0",
      "plan",
      SpanKind.LLM,
      10,
      300,
      { total_tokens: 150, cost: 0.002, model_name: "gpt-5" },
    ],
    ["c2", "c0", "answer", SpanKind.LLM, 310, 400],
  ],
  { input: '"Explain the refund window."', output: '"Refunds within 30 days."' },
);
const NODES = traceUnion(BASELINE, CANDIDATE).nodes;
const node = (name: string) => NODES.find((n) => (n.candidate ?? n.baseline)!.name === name)!;
const shown = (n: UnionNode) => (n.candidate ?? n.baseline)!;

function renderPanel(selection: TraceSelection, diff: Partial<SpanInfoDiff> = {}) {
  const onLayoutChange = vi.fn();
  const props = {
    projectId: "p1",
    trace: CANDIDATE,
    selection,
  };
  const full: SpanInfoDiff = {
    baseline: BASELINE,
    node: selection.type === "span" ? NODES.find((n) => shown(n) === selection.span)! : null,
    measured: true,
    layout: "columns",
    onLayoutChange,
    ...diff,
  };
  const utils = render(<SpanInfoPanel {...props} diff={full} />);
  return {
    ...utils,
    onLayoutChange,
    rerender: (d: Partial<SpanInfoDiff>) =>
      utils.rerender(<SpanInfoPanel {...props} diff={{ ...full, ...d }} />),
  };
}

/** The box titled `title` (Input, Output, Metadata): a diff box, or the panel's usual one. */
const box = (title: string) =>
  screen.getByText(title, { selector: "span.text-xs" }).closest<HTMLElement>(".rounded-md")!;
const chip = (name: string) => document.querySelector<HTMLElement>(`[data-diff-chip="${name}"]`);

beforeEach(() => {
  io.calls = [];
  io.byKey = new Map([
    [
      "tb/b1",
      {
        input: '{"prompt":"plan the refund"}',
        output: '"Refunds within 14 days."',
        metadata: '{"temperature":0}',
      },
    ],
    [
      "tc/c1",
      {
        input: '{"prompt":"plan the refund"}',
        output: '"Refunds within 30 days."',
        metadata: '{"temperature":0.2}',
      },
    ],
    ["tb/b2", { input: '"refund policy"', output: '"Policy text"' }],
    ["tc/c2", { input: '"refund window"', output: '"Here is the answer"' }],
  ]);
});
afterEach(() => cleanup());

describe("SpanInfoPanel in diff mode", () => {
  it("reads a matched span's chips before → after, and says how it was paired", () => {
    renderPanel({ type: "span", span: shown(node("plan")) });

    expect(chip("state")!.textContent).toBe("Matched · by path: agent › llm:plan #1");
    expect(chip("latency")!.textContent).toBe("Latency:90ms → 290ms+200ms");
    expect(within(chip("latency")!).getByText("+200ms").className).toContain("text-danger");
    expect(chip("tokens")!.textContent).toBe("100 → 150+50");
    expect(chip("cost")!.textContent).toBe("$0.001 → $0.002+$0.001");
    expect(chip("model")!.textContent).toBe("gpt-4o → gpt-5");
  });

  it("diffs its input, output and metadata in the panel's boxes, word by word", () => {
    renderPanel({ type: "span", span: shown(node("plan")) });

    expect(within(box("Input")).getByText("No differences.")).toBeTruthy();
    const output = box("Output");
    expect(
      [...output.querySelectorAll("[data-line='remove'] [data-line-text]")].map(
        (l) => l.textContent,
      ),
    ).toEqual(["Refunds within 14 days."]);
    expect(
      [...output.querySelectorAll("[data-line='add'] [data-line-text]")].map((l) => l.textContent),
    ).toEqual(["Refunds within 30 days."]);
    expect([...output.querySelectorAll("[data-word]")].map((w) => w.textContent)).toEqual([
      "14",
      "30",
    ]);
    expect(box("Metadata").querySelector("[data-line='add']")!.textContent).toContain("0.2");
    // Each run's value from its own trace.
    expect(io.calls).toEqual(expect.arrayContaining(["tb/b1", "tc/c1"]));
  });

  it("switches the boxes between side by side and inline", () => {
    const { onLayoutChange, rerender } = renderPanel({ type: "span", span: shown(node("plan")) });
    const toggle = (layout: string) => within(box("Output")).getByRole("button", { name: layout });

    expect(toggle("Side by side").getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(toggle("Inline"));
    expect(onLayoutChange).toHaveBeenCalledWith("inline");

    rerender({ layout: "inline" });
    expect(
      within(box("Input")).getByRole("button", { name: "Inline" }).getAttribute("aria-pressed"),
    ).toBe("true");
  });

  it("shows a span only this run has on its own, from this trace", () => {
    renderPanel({ type: "span", span: shown(node("answer")) });

    expect(chip("state")!.textContent).toBe("Added · not in the baseline");
    expect(within(box("Output")).getByText(/Here is the answer/)).toBeTruthy();
    expect(io.calls.every((c) => c.startsWith("tc/"))).toBe(true);
  });

  it("shows a span only the baseline has from the baseline's trace, fetching nothing from this one", () => {
    renderPanel({ type: "span", span: shown(node("web_search")) });

    expect(chip("state")!.textContent).toBe("Removed · only in the baseline");
    expect(within(box("Input")).getByText(/refund policy/)).toBeTruthy();
    expect(io.calls).toContain("tb/b2");
    expect(io.calls.some((c) => c.startsWith("tc/"))).toBe(false);
  });

  it("leaves the figures out when either trace is a reconstruction", () => {
    renderPanel({ type: "span", span: shown(node("plan")) }, { measured: false });
    expect(chip("latency")).toBeNull();
    expect(chip("tokens")).toBeNull();
    expect(chip("cost")).toBeNull();
    expect(chip("state")).not.toBeNull();
  });
});

describe("SpanInfoPanel in diff mode, at the trace root", () => {
  it("compares the whole traces when the host has nothing of its own", () => {
    renderPanel({ type: "trace" });

    expect(chip("state")).toBeNull();
    expect(chip("latency")!.textContent).toBe("Latency:1.0s → 1.6s+600ms");
    const output = box("Output");
    expect([...output.querySelectorAll("[data-word]")].map((w) => w.textContent)).toEqual([
      "14",
      "30",
    ]);
  });

  it("shows the host's case in place of the root's chips and boxes", () => {
    renderPanel(
      { type: "trace" },
      {
        root: {
          tags: <span data-diff-chip="case">Case figures</span>,
          body: <div>Case outputs</div>,
        },
      },
    );

    expect(screen.getByText("Case figures")).toBeTruthy();
    expect(screen.getByText("Case outputs")).toBeTruthy();
    expect(chip("latency")).toBeNull();
    expect(screen.queryByRole("button", { name: "Input" })).toBeNull();
    // The span kind still leads the chips, as on any root.
    expect(screen.getByText("Span kind:")).toBeTruthy();
  });
});
