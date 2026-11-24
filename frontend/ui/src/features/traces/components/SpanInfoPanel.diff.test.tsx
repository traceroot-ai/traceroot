// @vitest-environment jsdom
/**
 * The span detail panel in diff mode: the selected span compared with its counterpart in a
 * baseline trace of the same case. The chips read before → after and say how the span
 * was paired; Input, Output and Metadata stay in their boxes with a diff for a body; a span
 * only one run has shows that run's values; the trace root shows the host's case.
 */
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { SpanKind, SpanStatus } from "@traceroot/core";
import { traceUnion, type UnionNode } from "@/lib/eval/union-tree";
import type { Span, SpanIO, TraceDetail } from "@/types/api";
import type { TraceSelection } from "../types";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
// Span I/O is fetched per trace and span; the fixture map is keyed "traceId/spanId".
const io = vi.hoisted(() => ({
  byKey: new Map<string, Partial<SpanIO>>(),
  calls: [] as string[],
  // Keys still in flight, and keys whose fetch failed.
  pending: new Set<string>(),
  failed: new Set<string>(),
}));
vi.mock("../hooks", () => ({
  useSpanIO: (_p: string, traceId: string, spanId: string | null) => {
    if (spanId) io.calls.push(`${traceId}/${spanId}`);
    const key = `${traceId}/${spanId}`;
    return {
      data: spanId ? io.byKey.get(key) : undefined,
      isLoading: !!spanId && io.pending.has(key),
      isError: !!spanId && io.failed.has(key),
    };
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
  io.pending = new Set();
  io.failed = new Set();
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

  it("reads this trace's own figures when there is no baseline trace and no host chips", () => {
    renderPanel({ type: "trace" }, { baseline: null, root: { body: <div>Case outputs</div> } });

    expect(chip("latency")!.textContent).toBe("Latency:1.6s");
    expect(screen.getByText("Case outputs")).toBeTruthy();
  });
});

describe("SpanInfoPanel in diff mode with image references", () => {
  const HASH = "1".repeat(64);
  const REF = `traceroot-attachment://v1/sha256/${HASH}?bytes=68&mime=image/png`;
  const image = () => box("Input").querySelector("img");

  beforeEach(() => {
    io.byKey.set("tb/b2", { input: REF });
    io.byKey.set("tc/c2", { input: REF });
  });

  it("loads a span only one run has through that run's span", () => {
    renderPanel({ type: "span", span: shown(node("web_search")) });
    expect(image()!.getAttribute("src")).toBe(
      `/api/projects/p1/traces/tb/spans/b2/attachments/${HASH}`,
    );
    cleanup();

    renderPanel({ type: "span", span: shown(node("answer")) });
    expect(image()!.getAttribute("src")).toBe(
      `/api/projects/p1/traces/tc/spans/c2/attachments/${HASH}`,
    );
  });

  it("keeps references as text on a side that is a reconstruction", () => {
    // A reconstruction has no stored spans to load an image through.
    renderPanel(
      { type: "span", span: shown(node("web_search")) },
      { measured: false, reconstructed: { baseline: true, candidate: false } },
    );
    expect(image()).toBeNull();
    expect(box("Input").textContent).toContain(REF);
    cleanup();

    renderPanel(
      { type: "span", span: shown(node("answer")) },
      { measured: false, reconstructed: { baseline: false, candidate: true } },
    );
    expect(image()).toBeNull();
    cleanup();

    // The other side's images still load when only one side is a reconstruction.
    renderPanel(
      { type: "span", span: shown(node("answer")) },
      { measured: false, reconstructed: { baseline: true, candidate: false } },
    );
    expect(image()).not.toBeNull();
  });
});

/** The panel on `spanId` of `candidate`, diffed against `baseline`. */
function renderPair(baseline: TraceDetail, candidate: TraceDetail, spanId: string) {
  const n = traceUnion(baseline, candidate).nodes.find((x) => x.candidate?.span_id === spanId)!;
  return render(
    <SpanInfoPanel
      projectId="p1"
      trace={candidate}
      selection={{ type: "span", span: n.candidate! }}
      diff={{ baseline, node: n, measured: true, layout: "columns", onLayoutChange: vi.fn() }}
    />,
  );
}

describe("SpanInfoPanel in diff mode on a retried call", () => {
  // The candidate's first web_search failed and ran again, and its answer took more tokens.
  const RETRY_BASELINE = traceOf("tb3", [
    ["b-eval", null, "evaluation-item", SpanKind.EVALUATION, 0, 2000],
    ["b-task", "b-eval", "task", SpanKind.TASK, 10, 1900],
    ["b-agent", "b-task", "agent", SpanKind.AGENT, 20, 1800],
    ["b-s1", "b-agent", "web_search", SpanKind.TOOL, 30, 200],
    ["b-s2", "b-agent", "web_search", SpanKind.TOOL, 210, 400],
    ["b-answer", "b-agent", "compose_answer", SpanKind.LLM, 410, 1000, { total_tokens: 1200 }],
  ]);
  const RETRY_CANDIDATE = traceOf("tc3", [
    ["c-eval", null, "evaluation-item", SpanKind.EVALUATION, 0, 2400],
    ["c-task", "c-eval", "task", SpanKind.TASK, 10, 2300],
    ["c-agent", "c-task", "agent", SpanKind.AGENT, 20, 2200],
    ["c-s1", "c-agent", "web_search", SpanKind.TOOL, 30, 100, { status: SpanStatus.ERROR }],
    ["c-s2", "c-agent", "web_search", SpanKind.TOOL, 110, 300],
    ["c-s3", "c-agent", "web_search", SpanKind.TOOL, 310, 500],
    ["c-answer", "c-agent", "compose_answer", SpanKind.LLM, 510, 1300, { total_tokens: 1900 }],
  ]);

  it("pairs the third call with the baseline's second, by path", () => {
    renderPair(RETRY_BASELINE, RETRY_CANDIDATE, "c-s3");
    expect(chip("state")!.textContent).toBe(
      "Matched · by path: evaluation-item › task › agent › tool:web_search #2 → #3",
    );
  });

  it("reads the answer's tokens 1.2K → 1.9K +700, the change in red", () => {
    renderPair(RETRY_BASELINE, RETRY_CANDIDATE, "c-answer");
    expect(chip("tokens")!.textContent).toBe("1.2K → 1.9K+700");
    expect(within(chip("tokens")!).getByText("+700").className).toContain("text-danger");
  });

  it("shows the failed first call as this run's alone, with its own figure and error", () => {
    renderPair(RETRY_BASELINE, RETRY_CANDIDATE, "c-s1");
    expect(chip("state")!.textContent).toBe("Added · not in the baseline");
    expect(chip("latency")!.textContent).toBe("Latency:70ms");
    expect(screen.getByText("ERROR", { selector: "div" })).toBeTruthy();
  });
});

describe("SpanInfoPanel in diff mode, how a span was paired", () => {
  it("adds that the call ran in parallel with others of its name", () => {
    const rows = (prefix: string): Row[] => [
      [`${prefix}0`, null, "agent", SpanKind.AGENT, 0, 1000],
      [`${prefix}1`, `${prefix}0`, "web_search", SpanKind.TOOL, 10, 200],
      [`${prefix}2`, `${prefix}0`, "web_search", SpanKind.TOOL, 20, 210],
    ];
    renderPair(traceOf("tb5", rows("b")), traceOf("tc5", rows("c")), "c1");
    expect(chip("state")!.textContent).toBe(
      "Matched · by path: agent › tool:web_search #1 · one of 2 parallel web_search calls, paired by start order",
    );
  });

  it("adds where the span sits in the candidate when it ran under another parent", () => {
    // The candidate's first `step` failed and was retried; its `fetch` pairs with the
    // baseline's, under the retry.
    const baseline = traceOf("tb6", [
      ["b-root", null, "agent", SpanKind.AGENT, 0, 1000],
      ["b-step", "b-root", "step", SpanKind.SPAN, 10, 500],
      ["b-fetch", "b-step", "fetch", SpanKind.TOOL, 20, 400],
    ]);
    const candidate = traceOf("tc6", [
      ["c-root", null, "agent", SpanKind.AGENT, 0, 1000],
      ["c-step1", "c-root", "step", SpanKind.SPAN, 10, 300, { status: SpanStatus.ERROR }],
      ["c-fetch", "c-step1", "fetch", SpanKind.TOOL, 20, 250],
      ["c-step2", "c-root", "step", SpanKind.SPAN, 310, 900],
    ]);
    renderPair(baseline, candidate, "c-fetch");
    expect(chip("state")!.textContent).toBe(
      "Matched · by path: agent › step › tool:fetch #1 · in the candidate it sits under step #1",
    );
  });
});

describe("SpanInfoPanel in diff mode, a span whose status changed", () => {
  it("reads OK → ERROR", () => {
    const baseline = traceOf("tb4", [["b0", null, "agent", SpanKind.AGENT, 0, 100]]);
    const candidate = traceOf("tc4", [
      ["c0", null, "agent", SpanKind.AGENT, 0, 100, { status: SpanStatus.ERROR }],
    ]);
    renderPair(baseline, candidate, "c0");
    expect(chip("status")!.textContent).toBe("Status:OK → ERROR");
  });
});

describe("SpanInfoPanel in diff mode, before a span's stored metadata arrives", () => {
  // The trace skeleton's metadata is only the SDK's path keys; the stored value is fetched
  // per span.
  const skeleton = (idsPath: string[], path: string[]) =>
    JSON.stringify({ "traceroot.span.ids_path": idsPath, "traceroot.span.path": path });
  const traces = (planMetadata = skeleton(["b0"], ["agent", "plan"])) => [
    traceOf("tb7", [
      ["b0", null, "agent", SpanKind.AGENT, 0, 1000, { metadata: skeleton([], ["agent"]) }],
      ["b1", "b0", "plan", SpanKind.LLM, 10, 100, { metadata: planMetadata }],
    ]),
    traceOf("tc7", [
      ["c0", null, "agent", SpanKind.AGENT, 0, 1000, { metadata: skeleton([], ["agent"]) }],
      [
        "c1",
        "c0",
        "plan",
        SpanKind.LLM,
        10,
        100,
        { metadata: skeleton(["c0"], ["agent", "plan"]) },
      ],
    ]),
  ];
  const metadata = () => within(box("Metadata"));
  const added = () => box("Metadata").querySelector("[data-line='add']");

  beforeEach(() => io.byKey.set("tc7/c1", { metadata: '{"temperature":0.2}' }));

  it("says Loading… for the baseline, not that this run's keys were added", () => {
    io.pending.add("tb7/b1");
    const [baseline, candidate] = traces();
    renderPair(baseline, candidate, "c1");
    expect(metadata().getByText("Loading…")).toBeTruthy();
    expect(added()).toBeNull();
  });

  it("says the baseline's couldn't load, and offers none of it to copy", () => {
    io.failed.add("tb7/b1");
    const [baseline, candidate] = traces();
    renderPair(baseline, candidate, "c1");
    expect(metadata().getByText("Couldn't load this span's metadata")).toBeTruthy();
    expect(metadata().queryByRole("button", { name: "Copy baseline metadata" })).toBeNull();
    expect(added()).toBeNull();
  });

  it("says both couldn't load, rather than No differences.", () => {
    io.byKey.delete("tc7/c1");
    io.failed.add("tb7/b1");
    io.failed.add("tc7/c1");
    const [baseline, candidate] = traces();
    renderPair(baseline, candidate, "c1");
    expect(metadata().getAllByText("Couldn't load this span's metadata")).toHaveLength(2);
    expect(metadata().queryByText("No differences.")).toBeNull();
  });

  it("compares metadata a span carries in full though its fetch failed", () => {
    io.failed.add("tb7/b1");
    const [baseline, candidate] = traces(
      JSON.stringify({ temperature: 0, "traceroot.span.ids_path": ["b0"] }),
    );
    renderPair(baseline, candidate, "c1");
    expect(added()!.textContent).toContain("0.2");
  });
});

describe("SpanInfoPanel in diff mode, each side of a box", () => {
  const plan = () => ({ type: "span" as const, span: shown(node("plan")) });

  it("names the sides Baseline and This run, each with its own copy button", () => {
    renderPanel(plan());
    const output = within(box("Output"));
    expect(output.getByRole("heading", { name: "Baseline" })).toBeTruthy();
    expect(output.getByRole("heading", { name: "This run" })).toBeTruthy();
    expect(output.getByRole("button", { name: "Copy baseline output" })).toBeTruthy();
    expect(output.getByRole("button", { name: "Copy this run output" })).toBeTruthy();
  });

  it("names the sides as the host does", () => {
    renderPanel(plan(), {
      sides: {
        baseline: { label: "Baseline", tag: "#1", dot: "bg-muted-foreground" },
        candidate: { label: "Candidate", tag: "#2", dot: "bg-primary" },
      },
    });
    const input = within(box("Input"));
    expect(input.getByRole("heading", { name: "Baseline · #1" })).toBeTruthy();
    expect(input.getByRole("heading", { name: "Candidate · #2" })).toBeTruthy();
    expect(input.getByRole("button", { name: "Copy candidate input" })).toBeTruthy();
  });

  it("says Loading… on a side still in flight, and when a side couldn't load", () => {
    io.byKey.delete("tb/b1");
    io.pending.add("tb/b1");
    renderPanel(plan());
    expect(within(box("Output")).getByText("Loading…")).toBeTruthy();
    expect(within(box("Output")).getByText("Refunds within 30 days.")).toBeTruthy();
    cleanup();

    io.byKey.delete("tc/c1");
    io.failed.add("tc/c1");
    renderPanel(plan());
    expect(within(box("Output")).getByText("Couldn't load this span's output")).toBeTruthy();
  });

  it("keeps each box collapsible", () => {
    renderPanel(plan());
    const toggle = screen.getByRole("button", { name: "Output" });
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(box("Output").querySelector("[data-line]")).toBeNull();
  });

  it("copies a span only one run has from its usual box", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    renderPanel({ type: "span", span: shown(node("answer")) });
    await act(async () => {
      fireEvent.click(within(box("Output")).getByTitle("Copy"));
    });
    expect(writeText).toHaveBeenCalledWith('"Here is the answer"');
  });
});

describe("SpanInfoPanel in diff mode with long values", () => {
  const plan = () => ({ type: "span" as const, span: shown(node("plan")) });
  // 20,000 characters in common, then a word apart.
  const COMMON = "a".repeat(20_000);
  /** The length of each shown line of a kind in the Output box. */
  const shownLines = (kind: "add" | "remove") =>
    [...box("Output").querySelectorAll(`[data-line='${kind}'] [data-line-text]`)].map(
      (l) => l.textContent!.length,
    );
  const markedWords = () =>
    [...box("Output").querySelectorAll("[data-word]")].map((w) => w.textContent);

  beforeEach(() => {
    io.byKey.set("tb/b1", { output: `${COMMON} before` });
    io.byKey.set("tc/c1", { output: `${COMMON} after` });
  });

  it("shows the first 20,000 characters of each until Show full, then Show less", () => {
    const { rerender } = renderPanel(plan());
    const output = within(box("Output"));
    expect(output.getByText("Showing the first 20,000 characters of each value.")).toBeTruthy();
    expect(
      output.getByText("The first 20,000 characters match; the values differ after that."),
    ).toBeTruthy();
    // Compared whole: the lines read as changed, though the parts shown are the same.
    expect(shownLines("remove")).toEqual([20_000]);
    expect(shownLines("add")).toEqual([20_000]);
    expect(markedWords()).toEqual([]);

    fireEvent.click(output.getByRole("button", { name: "Show full" }));
    expect(output.getByText("Showing each value in full.")).toBeTruthy();
    expect(output.queryByText(/characters match/)).toBeNull();
    expect(shownLines("remove")).toEqual([20_007]);
    expect(markedWords()).toEqual(["before", "after"]);

    fireEvent.click(output.getByRole("button", { name: "Show less" }));
    expect(shownLines("add")).toEqual([20_000]);

    // The inline diff is cut the same way.
    rerender({ layout: "inline" });
    expect(shownLines("remove")).toEqual([20_000]);
    expect(shownLines("add")).toEqual([20_000]);
  });

  it("copies the whole value, not the part shown", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    renderPanel(plan());
    await act(async () => {
      fireEvent.click(within(box("Output")).getByRole("button", { name: "Copy this run output" }));
    });
    expect(writeText).toHaveBeenCalledWith(`${COMMON} after`);
  });

  it("says a pair too large to align is too long, in the Metadata box as metadata values", () => {
    // 1,500 keys a side, none shared: past what the line alignment takes on.
    const keys = (prefix: string) =>
      JSON.stringify(
        Object.fromEntries(Array.from({ length: 1500 }, (_, i) => [`${prefix}${i}`, i])),
      );
    io.byKey.set("tb/b1", { metadata: keys("baseline_") });
    io.byKey.set("tc/c1", { metadata: keys("candidate_") });
    renderPanel(plan());
    expect(
      within(box("Metadata")).getByText(
        "These metadata values are too long to compare line by line.",
      ),
    ).toBeTruthy();
    expect(box("Metadata").querySelector("[data-line='add']")).toBeNull();
  });
});

describe("SpanInfoPanel in diff mode with redaction", () => {
  const plan = () => ({ type: "span" as const, span: shown(node("plan")) });

  it("keeps the SDK's own keys and the redaction marker out of the Metadata comparison", () => {
    io.byKey.set("tb/b1", {
      metadata: JSON.stringify({
        temperature: 0,
        "traceroot.span.ids_path": ["b0", "b1"],
        "traceroot.redacted": true,
      }),
    });
    io.byKey.set("tc/c1", {
      metadata: JSON.stringify({ temperature: 0, "traceroot.span.ids_path": ["c0", "c1"] }),
    });
    renderPanel(plan());
    expect(within(box("Metadata")).getByText("No differences.")).toBeTruthy();
    expect(box("Metadata").textContent).not.toContain("traceroot.");
    // Either run's redaction shows.
    expect(screen.getByText("Redacted by your app")).toBeTruthy();
  });

  it("says nothing of redaction when neither run's span was redacted", () => {
    renderPanel(plan());
    expect(screen.queryByText("Redacted by your app")).toBeNull();
  });
});
