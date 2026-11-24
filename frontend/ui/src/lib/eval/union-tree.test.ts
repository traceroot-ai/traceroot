import { describe, it, expect } from "vitest";
import { SpanKind, SpanStatus } from "@traceroot/core";
import type { Span, TraceDetail } from "@/types/api";
import { buildSpanTree } from "@/features/traces/utils";
import { describeMatchReason } from "./span-match";
import {
  buildUnionTree,
  divergenceCounts,
  isMovedNode,
  metricDirection,
  traceUnion,
  unionNodeName,
  unionParentIds,
  visibleUnionNodes,
  type UnionNode,
} from "./union-tree";

const T0 = Date.UTC(2026, 0, 1);
const at = (ms: number) => new Date(T0 + ms).toISOString();

type Row = [
  id: string,
  parent: string | null,
  name: string,
  kind?: Span["span_kind"],
  extra?: Partial<Span>,
];

// Spans start 10ms apart in listed order and run 5ms, so siblings sort as written.
function trace(rows: Row[]): Span[] {
  return rows.map(([span_id, parent_span_id, name, span_kind = SpanKind.SPAN, extra], i) => ({
    span_id,
    trace_id: "trace",
    parent_span_id,
    name,
    span_kind,
    span_start_time: at(i * 10),
    span_end_time: at(i * 10 + 5),
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
    ...extra,
  }));
}

const shape = (nodes: UnionNode[]) =>
  nodes.map((n) => `${n.state}:${(n.candidate ?? n.baseline)!.name}`);
const node = (nodes: UnionNode[], id: string) => nodes.find((n) => n.id === id)!;

describe("buildUnionTree", () => {
  it("lays out two identical traces as matched nodes, shaped like the trace tree", () => {
    const rows: Row[] = [
      ["root", null, "agent", SpanKind.AGENT],
      ["plan", "root", "plan", SpanKind.AGENT],
      ["plan-llm", "plan", "chat", SpanKind.LLM],
      ["search", "root", "web_search", SpanKind.TOOL],
      ["answer", "root", "answer", SpanKind.LLM],
    ];
    const baseline = trace(
      rows.map(([id, p, ...rest]): Row => [`b-${id}`, p && `b-${p}`, ...rest]),
    );
    const candidate = trace(
      rows.map(([id, p, ...rest]): Row => [`c-${id}`, p && `c-${p}`, ...rest]),
    );

    const { nodes, counts } = buildUnionTree(baseline, candidate);

    expect(counts).toEqual({ matched: 5, added: 0, removed: 0, total: 5 });
    expect(nodes.every((n) => n.state === "matched" && !n.changed)).toBe(true);
    expect(nodes.map((n) => [n.id, n.level, n.isTerminal, n.parentLevels])).toEqual(
      buildSpanTree(baseline).map((r) => [
        `baseline:${r.span.span_id}`,
        r.level,
        r.isTerminal,
        r.parentLevels,
      ]),
    );
    expect(node(nodes, "baseline:b-plan-llm").parentId).toBe("baseline:b-plan");
  });

  it("shows an extra web_search span as added between its matched neighbours", () => {
    const baseline = trace([
      ["b-root", null, "agent", SpanKind.AGENT],
      ["b-plan", "b-root", "plan", SpanKind.LLM],
      ["b-answer", "b-root", "answer", SpanKind.LLM],
    ]);
    const candidate = trace([
      ["c-root", null, "agent", SpanKind.AGENT],
      ["c-plan", "c-root", "plan", SpanKind.LLM],
      ["c-search", "c-root", "web_search", SpanKind.TOOL],
      ["c-answer", "c-root", "answer", SpanKind.LLM],
    ]);

    const { nodes, counts } = buildUnionTree(baseline, candidate);

    expect(shape(nodes)).toEqual([
      "matched:agent",
      "matched:plan",
      "added:web_search",
      "matched:answer",
    ]);
    expect(counts).toEqual({ matched: 3, added: 1, removed: 0, total: 4 });
    const added = node(nodes, "candidate:c-search");
    expect(added).toMatchObject({
      state: "added",
      parentId: "baseline:b-root",
      level: 1,
      baseline: null,
      reason: null,
      changed: true,
    });
    expect(added.candidate?.span_id).toBe("c-search");
  });

  it("keeps a span the candidate dropped in its baseline position as removed", () => {
    const baseline = trace([
      ["b-root", null, "agent", SpanKind.AGENT],
      ["b-search", "b-root", "web_search", SpanKind.TOOL],
      ["b-fetch", "b-search", "fetch", SpanKind.TOOL],
      ["b-answer", "b-root", "answer", SpanKind.LLM],
    ]);
    const candidate = trace([
      ["c-root", null, "agent", SpanKind.AGENT],
      ["c-search", "c-root", "web_search", SpanKind.TOOL],
      ["c-answer", "c-root", "answer", SpanKind.LLM],
    ]);

    const { nodes, counts } = buildUnionTree(baseline, candidate);

    expect(shape(nodes)).toEqual([
      "matched:agent",
      "matched:web_search",
      "removed:fetch",
      "matched:answer",
    ]);
    expect(counts).toEqual({ matched: 3, added: 0, removed: 1, total: 4 });
    expect(node(nodes, "baseline:b-fetch")).toMatchObject({
      parentId: "baseline:b-search",
      level: 2,
      candidate: null,
      reason: null,
    });
  });

  it("shows a renamed span as removed, then added, in the same place", () => {
    const baseline = trace([
      ["b-root", null, "agent", SpanKind.AGENT],
      ["b-search", "b-root", "web_search", SpanKind.TOOL],
      ["b-answer", "b-root", "answer", SpanKind.LLM],
      ["b-cite", "b-root", "cite", SpanKind.TOOL],
    ]);
    const candidate = trace([
      ["c-root", null, "agent", SpanKind.AGENT],
      ["c-search", "c-root", "web_search", SpanKind.TOOL],
      ["c-answer", "c-root", "final_answer", SpanKind.LLM],
      ["c-cite", "c-root", "cite", SpanKind.TOOL],
    ]);

    const { nodes, counts } = buildUnionTree(baseline, candidate);

    expect(shape(nodes)).toEqual([
      "matched:agent",
      "matched:web_search",
      "removed:answer",
      "added:final_answer",
      "matched:cite",
    ]);
    expect(counts).toEqual({ matched: 3, added: 1, removed: 1, total: 5 });
  });

  it("grafts a new subtree under its new parent, intact", () => {
    const baseline = trace([
      ["b-root", null, "agent", SpanKind.AGENT],
      ["b-answer", "b-root", "answer", SpanKind.LLM],
    ]);
    const candidate = trace([
      ["c-root", null, "agent", SpanKind.AGENT],
      ["c-plan", "c-root", "planner", SpanKind.AGENT],
      ["c-search", "c-plan", "web_search", SpanKind.TOOL],
      ["c-fetch", "c-search", "fetch", SpanKind.TOOL],
      ["c-answer", "c-root", "answer", SpanKind.LLM],
    ]);

    const { nodes } = buildUnionTree(baseline, candidate);

    expect(shape(nodes)).toEqual([
      "matched:agent",
      "added:planner",
      "added:web_search",
      "added:fetch",
      "matched:answer",
    ]);
    expect(nodes.map((n) => [n.parentId, n.level])).toEqual([
      [null, 0],
      ["baseline:b-root", 1],
      ["candidate:c-plan", 2],
      ["candidate:c-search", 3],
      ["baseline:b-root", 1],
    ]);
  });

  it("shows a renamed parent's subtree as removed, then the new one as added", () => {
    const baseline = trace([
      ["b-root", null, "agent", SpanKind.AGENT],
      ["b-plan", "b-root", "planner", SpanKind.AGENT],
      ["b-search", "b-plan", "web_search", SpanKind.TOOL],
      ["b-fetch", "b-search", "fetch", SpanKind.TOOL],
    ]);
    const candidate = trace([
      ["c-root", null, "agent", SpanKind.AGENT],
      ["c-plan", "c-root", "planner_v2", SpanKind.AGENT],
      ["c-search", "c-plan", "web_search", SpanKind.TOOL],
      ["c-fetch", "c-search", "fetch", SpanKind.TOOL],
    ]);

    const { nodes, counts } = buildUnionTree(baseline, candidate);

    expect(shape(nodes)).toEqual([
      "matched:agent",
      "removed:planner",
      "removed:web_search",
      "removed:fetch",
      "added:planner_v2",
      "added:web_search",
      "added:fetch",
    ]);
    expect(node(nodes, "baseline:b-fetch").level).toBe(3);
    expect(node(nodes, "candidate:c-fetch").parentId).toBe("candidate:c-search");
    expect(counts).toEqual({ matched: 1, added: 3, removed: 3, total: 7 });
  });

  it("follows the baseline's sibling order when the candidate reorders", () => {
    const baseline = trace([
      ["b-root", null, "agent", SpanKind.AGENT],
      ["b-search", "b-root", "web_search", SpanKind.TOOL],
      ["b-read", "b-root", "read_file", SpanKind.TOOL],
    ]);
    const candidate = trace([
      ["c-root", null, "agent", SpanKind.AGENT],
      ["c-read", "c-root", "read_file", SpanKind.TOOL],
      ["c-search", "c-root", "web_search", SpanKind.TOOL],
    ]);

    const { nodes } = buildUnionTree(baseline, candidate);

    expect(shape(nodes)).toEqual(["matched:agent", "matched:web_search", "matched:read_file"]);
  });

  it("carries the match reason on matched nodes", () => {
    const baseline = trace([
      ["b-root", null, "agent", SpanKind.AGENT],
      ["b-1", "b-root", "web_search", SpanKind.TOOL],
      ["b-2", "b-root", "web_search", SpanKind.TOOL],
    ]);
    const candidate = trace([
      ["c-root", null, "agent", SpanKind.AGENT],
      ["c-1", "c-root", "web_search", SpanKind.TOOL],
      ["c-2", "c-root", "web_search", SpanKind.TOOL],
    ]);

    const { nodes } = buildUnionTree(baseline, candidate);
    const second = node(nodes, "baseline:b-2");

    expect(second.state).toBe("matched");
    expect(second.reason && describeMatchReason(second.reason)).toBe(
      "Matched by path: agent › tool:web_search #2",
    );
  });

  it("pairs duration, tokens and cost per node and keeps unknown values null", () => {
    const baseline = trace([
      ["b-root", null, "agent", SpanKind.AGENT],
      ["b-llm", "b-root", "chat", SpanKind.LLM, { total_tokens: 100, cost: 0.002 }],
      ["b-tool", "b-root", "web_search", SpanKind.TOOL, { span_end_time: null }],
    ]);
    const candidate = trace([
      ["c-root", null, "agent", SpanKind.AGENT],
      [
        "c-llm",
        "c-root",
        "chat",
        SpanKind.LLM,
        { input_tokens: 70, output_tokens: 50, span_end_time: at(10 + 40) },
      ],
      ["c-tool", "c-root", "web_search", SpanKind.TOOL],
      ["c-extra", "c-root", "summarize", SpanKind.LLM, { total_tokens: 30, cost: 0 }],
    ]);

    const { nodes } = buildUnionTree(baseline, candidate);

    expect(node(nodes, "baseline:b-root").metrics).toEqual({
      durationMs: { baseline: 5, candidate: 5 },
      totalTokens: { baseline: null, candidate: null },
      cost: { baseline: null, candidate: null },
    });
    expect(node(nodes, "baseline:b-llm").metrics).toEqual({
      durationMs: { baseline: 5, candidate: 40 },
      totalTokens: { baseline: 100, candidate: 120 },
      cost: { baseline: 0.002, candidate: null },
    });
    // Still running on the baseline side: no duration yet, not zero.
    expect(node(nodes, "baseline:b-tool").metrics.durationMs).toEqual({
      baseline: null,
      candidate: 5,
    });
    expect(node(nodes, "candidate:c-extra").metrics).toEqual({
      durationMs: { baseline: null, candidate: 5 },
      totalTokens: { baseline: null, candidate: 30 },
      cost: { baseline: null, candidate: 0 },
    });
  });

  it("marks matched spans changed on status, model, tokens, cost or a large change in duration", () => {
    const baseline = trace([
      ["b-root", null, "agent", SpanKind.AGENT],
      ["b-same", "b-root", "same", SpanKind.LLM, { total_tokens: 10 }],
      ["b-slow", "b-root", "slow", SpanKind.LLM, { total_tokens: 10 }],
      ["b-tokens", "b-root", "tokens", SpanKind.LLM, { total_tokens: 10 }],
      ["b-status", "b-root", "status", SpanKind.TOOL],
      ["b-model", "b-root", "model", SpanKind.LLM, { model_name: "model-a" }],
      ["b-cost", "b-root", "cost", SpanKind.LLM, { cost: 0.01 }],
      ["b-rounding", "b-root", "rounding", SpanKind.LLM, { cost: 0.1 + 0.2 }],
      ["b-cost-gone", "b-root", "cost_gone", SpanKind.LLM, { cost: 0.01 }],
    ]);
    const candidate = trace([
      ["c-root", null, "agent", SpanKind.AGENT],
      ["c-same", "c-root", "same", SpanKind.LLM, { total_tokens: 10 }],
      ["c-slow", "c-root", "slow", SpanKind.LLM, { total_tokens: 10, span_end_time: at(10_000) }],
      ["c-tokens", "c-root", "tokens", SpanKind.LLM, { total_tokens: 12 }],
      ["c-status", "c-root", "status", SpanKind.TOOL, { status: SpanStatus.ERROR }],
      ["c-model", "c-root", "model", SpanKind.LLM, { model_name: "model-b" }],
      ["c-cost", "c-root", "cost", SpanKind.LLM, { cost: 0.02 }],
      ["c-rounding", "c-root", "rounding", SpanKind.LLM, { cost: 0.3 }],
      ["c-cost-gone", "c-root", "cost_gone", SpanKind.LLM],
    ]);

    const { nodes } = buildUnionTree(baseline, candidate);
    const changed = Object.fromEntries(nodes.map((n) => [n.baseline?.name, n.changed]));

    expect(changed).toEqual({
      agent: false,
      same: false,
      // 5ms → almost 10s.
      slow: true,
      tokens: true,
      status: true,
      model: true,
      cost: true,
      // Float noise in a summed price is not a change; a cost that went missing is.
      rounding: false,
      cost_gone: true,
    });
  });

  it("counts duration as changed only when it moves by half and by at least 100ms", () => {
    // [baseline ms, candidate ms] for each span.
    const durations: Record<string, [number, number]> = {
      jitter: [5, 60], // +55ms: over half, but under 100ms
      slower: [1000, 1400], // +400ms: under half
      double: [1000, 1600], // +600ms
      halved: [1000, 500], // −500ms
    };
    const side = (prefix: string, which: 0 | 1) =>
      trace([
        [`${prefix}-root`, null, "agent", SpanKind.AGENT, { span_end_time: at(10_000) }],
        ...Object.entries(durations).map(
          ([name, ms], i): Row => [
            `${prefix}-${name}`,
            `${prefix}-root`,
            name,
            SpanKind.TOOL,
            { span_start_time: at(i * 2000), span_end_time: at(i * 2000 + ms[which]) },
          ],
        ),
      ]);

    const { nodes } = buildUnionTree(side("b", 0), side("c", 1));
    const changed = Object.fromEntries(nodes.map((n) => [n.baseline?.name, n.changed]));

    expect(changed).toEqual({
      agent: false,
      jitter: false,
      slower: false,
      double: true,
      halved: true,
    });
  });

  it("counts a root paired across a rename as changed", () => {
    const { nodes } = buildUnionTree(
      trace([["b-root", null, "run-a", SpanKind.EVALUATION]]),
      trace([["c-root", null, "run-b", SpanKind.EVALUATION]]),
    );

    expect(nodes[0]).toMatchObject({ state: "matched", changed: true });
  });

  it("counts a span drawn under another parent than the one it ran under as changed", () => {
    const baseline = trace([
      ["b-root", null, "agent", SpanKind.AGENT],
      ["b-step", "b-root", "step"],
      ["b-fetch", "b-step", "fetch", SpanKind.TOOL],
    ]);
    const candidate = trace([
      ["c-root", null, "agent", SpanKind.AGENT],
      ["c-step1", "c-root", "step", undefined, { status: SpanStatus.ERROR }],
      ["c-fetch", "c-step1", "fetch", SpanKind.TOOL],
      ["c-step2", "c-root", "step"],
    ]);

    const { nodes } = buildUnionTree(baseline, candidate);

    expect(node(nodes, "baseline:b-fetch")).toMatchObject({
      state: "matched",
      parentId: "baseline:b-step",
      changed: true,
    });
    expect(node(nodes, "baseline:b-step").changed).toBe(false);
  });

  it("tags a scorer's subtree as evaluator spans, never counted as changed", () => {
    const evaluation = (prefix: string, judgeTokens: number) =>
      trace([
        [`${prefix}-root`, null, "evaluation-item", SpanKind.EVALUATION],
        [`${prefix}-task`, `${prefix}-root`, "task", SpanKind.TASK],
        [`${prefix}-answer`, `${prefix}-task`, "answer", SpanKind.LLM, { total_tokens: 100 }],
        [`${prefix}-scorer`, `${prefix}-root`, "faithfulness", SpanKind.SCORER],
        [
          `${prefix}-judge`,
          `${prefix}-scorer`,
          "judge",
          SpanKind.LLM,
          { total_tokens: judgeTokens, cost: judgeTokens / 1e6 },
        ],
      ]);

    const { nodes } = buildUnionTree(evaluation("b", 500), evaluation("c", 530));
    const tags = Object.fromEntries(nodes.map((n) => [n.baseline?.name, [n.evaluator, n.changed]]));

    expect(tags).toEqual({
      "evaluation-item": [false, false],
      task: [false, false],
      answer: [false, false],
      faithfulness: [true, false],
      // The judge spent more tokens, but that is the evaluation's cost, not the run's.
      judge: [true, false],
    });
  });

  it("treats a live span without usage keys like one that reported none", () => {
    // Streamed spans that never had usage arrive without the keys, not with nulls.
    const live = (spans: Span[]) =>
      spans.map((sp) => {
        const copy: Record<string, unknown> = { ...sp };
        for (const key of ["total_tokens", "input_tokens", "output_tokens", "cost", "model_name"]) {
          delete copy[key];
        }
        return copy as unknown as Span;
      });
    const rows: Row[] = [
      ["root", null, "agent", SpanKind.AGENT],
      ["search", "root", "web_search", SpanKind.TOOL],
    ];
    const { nodes } = buildUnionTree(trace(rows), live(trace(rows)));

    expect(nodes.map((n) => n.changed)).toEqual([false, false]);
    expect(nodes[1].metrics).toEqual({
      durationMs: { baseline: 5, candidate: 5 },
      totalTokens: { baseline: null, candidate: null },
      cost: { baseline: null, candidate: null },
    });
  });

  it("pairs a placeholder for a span not yet arrived by its name, whatever its kind", () => {
    // A placeholder stands in with a generic kind until the span lands.
    const placeholder = { pending: true, span_end_time: null };
    const { nodes } = buildUnionTree(
      trace([
        ["b-root", null, "agent", SpanKind.AGENT],
        ["b-plan", "b-root", "plan", SpanKind.AGENT],
        ["b-llm", "b-plan", "chat", SpanKind.LLM],
      ]),
      trace([
        ["c-root", null, "agent", SpanKind.SPAN, placeholder],
        ["c-plan", "c-root", "plan", SpanKind.SPAN, placeholder],
        ["c-llm", "c-plan", "chat", SpanKind.LLM],
      ]),
    );

    expect(shape(nodes)).toEqual(["matched:agent", "matched:plan", "matched:chat"]);
    expect(nodes[0].state === "matched" && nodes[0].reason.basis).toBe("path");
    // Not a renamed root, and not a change: it just hasn't arrived.
    expect(nodes.map((n) => n.changed)).toEqual([false, false, false]);
  });

  it("handles empty and one-sided traces", () => {
    const one = trace([
      ["x-root", null, "agent", SpanKind.AGENT],
      ["x-tool", "x-root", "web_search", SpanKind.TOOL],
    ]);

    expect(buildUnionTree([], [])).toEqual({
      nodes: [],
      counts: { matched: 0, added: 0, removed: 0, total: 0 },
    });

    const onlyCandidate = buildUnionTree([], one);
    expect(onlyCandidate.counts).toEqual({ matched: 0, added: 2, removed: 0, total: 2 });
    expect(onlyCandidate.nodes.map((n) => [n.id, n.parentId, n.level])).toEqual([
      ["candidate:x-root", null, 0],
      ["candidate:x-tool", "candidate:x-root", 1],
    ]);

    const onlyBaseline = buildUnionTree(one, []);
    expect(onlyBaseline.counts).toEqual({ matched: 0, added: 0, removed: 2, total: 2 });
    expect(onlyBaseline.nodes.map((n) => [n.id, n.parentId, n.level])).toEqual([
      ["baseline:x-root", null, 0],
      ["baseline:x-tool", "baseline:x-root", 1],
    ]);
  });

  it("keeps node ids distinct when both traces reuse span ids", () => {
    const baseline = trace([
      ["root", null, "agent", SpanKind.AGENT],
      ["s1", "root", "web_search", SpanKind.TOOL],
    ]);
    const candidate = trace([
      ["root", null, "agent", SpanKind.AGENT],
      ["s1", "root", "read_file", SpanKind.TOOL],
    ]);

    const { nodes } = buildUnionTree(baseline, candidate);

    expect(nodes.map((n) => n.id)).toEqual(["baseline:root", "baseline:s1", "candidate:s1"]);
  });

  it("places every span exactly once even with a parent cycle", () => {
    const baseline = trace([
      ["b-a", "b-b", "a"],
      ["b-b", "b-a", "b"],
    ]);
    const candidate = trace([
      ["c-a", "c-b", "a"],
      ["c-b", "c-a", "b"],
      ["c-x", "c-a", "x"],
      ["c-y", "c-z", "y"],
      ["c-z", "c-y", "z"],
    ]);

    const { nodes, counts } = buildUnionTree(baseline, candidate);

    expect(counts).toEqual({ matched: 2, added: 3, removed: 0, total: 5 });
    expect(new Set(nodes.map((n) => n.id)).size).toBe(5);
  });
});

const traceOf = (traceId: string, spans: Span[]): TraceDetail => ({
  trace_id: traceId,
  project_id: "p1",
  name: spans[0]?.name ?? "trace",
  trace_start_time: spans[0]?.span_start_time ?? at(0),
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
});

describe("traceUnion", () => {
  it("draws a placeholder for an ancestor that hasn't arrived, as the trace viewer does", () => {
    // The candidate's `plan` span is in, but its parent `agent` hasn't landed yet: its
    // recorded path names it, so the viewer draws a placeholder in its place.
    const paths = (ids: string[], names: string[]) => ({
      metadata: JSON.stringify({
        "traceroot.span.ids_path": ids,
        "traceroot.span.path": names,
      }),
    });
    const baseline = traceOf(
      "tb",
      trace([
        ["b-root", null, "agent", SpanKind.AGENT],
        ["b-plan", "b-root", "plan", SpanKind.LLM, paths(["b-root"], ["agent", "plan"])],
      ]),
    );
    const candidate = traceOf(
      "tc",
      trace([["c-plan", "c-root", "plan", SpanKind.LLM, paths(["c-root"], ["agent", "plan"])]]),
    );

    const { nodes } = traceUnion(baseline, candidate);

    expect(shape(nodes)).toEqual(["matched:agent", "matched:plan"]);
    expect(nodes[0].state === "matched" && nodes[0].candidate.pending).toBe(true);
  });

  it("reads a streamed span without usage keys as one that reported none", () => {
    const rows: Row[] = [["root", null, "agent", SpanKind.AGENT]];
    const streamed = trace(rows).map((sp) => {
      const copy: Record<string, unknown> = { ...sp };
      delete copy.cost;
      delete copy.total_tokens;
      return copy as unknown as Span;
    });

    const { nodes } = traceUnion(traceOf("tb", trace(rows)), traceOf("tc", streamed));

    expect(nodes[0].state === "matched" && nodes[0].candidate.cost).toBeNull();
    expect(nodes[0].changed).toBe(false);
  });
});

describe("divergenceCounts", () => {
  it("counts the run's own spans by state, leaving an evaluation's scorer spans out", () => {
    const baseline = trace([
      ["b-root", null, "evaluation-item", SpanKind.EVALUATION],
      ["b-task", "b-root", "task", SpanKind.TASK],
      ["b-search", "b-task", "web_search", SpanKind.TOOL],
      ["b-scorer", "b-root", "faithfulness", SpanKind.SCORER],
      ["b-judge", "b-scorer", "judge", SpanKind.LLM],
    ]);
    const candidate = trace([
      ["c-root", null, "evaluation-item", SpanKind.EVALUATION],
      ["c-task", "c-root", "task", SpanKind.TASK],
      ["c-answer", "c-task", "answer", SpanKind.LLM],
      ["c-scorer", "c-root", "faithfulness", SpanKind.SCORER],
      ["c-judge", "c-scorer", "judge", SpanKind.LLM],
      ["c-judge-2", "c-scorer", "judge-retry", SpanKind.LLM],
    ]);

    const { nodes } = buildUnionTree(baseline, candidate);

    // The judge's retry is the evaluation's, not the run's: it isn't counted.
    expect(divergenceCounts(nodes)).toEqual({ matched: 2, added: 1, removed: 1 });
  });
});

describe("union tree rows", () => {
  const { nodes } = buildUnionTree(
    trace([
      ["b-root", null, "agent", SpanKind.AGENT],
      ["b-plan", "b-root", "plan", SpanKind.AGENT],
      ["b-chat", "b-plan", "chat", SpanKind.LLM],
      ["b-search", "b-root", "web_search", SpanKind.TOOL],
    ]),
    trace([
      ["c-root", null, "agent", SpanKind.AGENT],
      ["c-plan", "c-root", "plan", SpanKind.AGENT],
      ["c-chat", "c-plan", "chat", SpanKind.LLM],
      ["c-answer", "c-root", "answer", SpanKind.LLM],
    ]),
  );
  const names = (list: UnionNode[]) => list.map((n) => (n.candidate ?? n.baseline)!.name);

  it("hides what is under a collapsed node, wherever it came from", () => {
    expect(names(visibleUnionNodes(nodes, new Set()))).toEqual([
      "agent",
      "plan",
      "chat",
      "web_search",
      "answer",
    ]);
    expect(names(visibleUnionNodes(nodes, new Set(["baseline:b-plan"])))).toEqual([
      "agent",
      "plan",
      "web_search",
      "answer",
    ]);
    expect(names(visibleUnionNodes(nodes, new Set(["baseline:b-root"])))).toEqual(["agent"]);
  });

  it("knows which nodes have children to collapse", () => {
    expect([...unionParentIds(nodes)].sort()).toEqual(["baseline:b-plan", "baseline:b-root"]);
  });
});

describe("unionNodeName and isMovedNode", () => {
  it("reads a root paired across a rename as old → new", () => {
    const { nodes } = buildUnionTree(
      trace([["b", null, "agent-v1", SpanKind.AGENT]]),
      trace([["c", null, "agent-v2", SpanKind.AGENT]]),
    );
    expect(unionNodeName(nodes[0])).toBe("agent-v1 → agent-v2");
  });

  it("flags a span that ran under another parent than the one it is drawn under", () => {
    // The candidate's first `step` failed and was retried: the retry pairs with the
    // baseline's step, while `fetch` ran under the failed attempt.
    const { nodes } = buildUnionTree(
      trace([
        ["b-root", null, "agent", SpanKind.AGENT],
        ["b-step", "b-root", "step"],
        ["b-fetch", "b-step", "fetch", SpanKind.TOOL],
      ]),
      trace([
        ["c-root", null, "agent", SpanKind.AGENT],
        ["c-step1", "c-root", "step", undefined, { status: SpanStatus.ERROR }],
        ["c-fetch", "c-step1", "fetch", SpanKind.TOOL],
        ["c-step2", "c-root", "step"],
      ]),
    );
    expect(nodes.filter(isMovedNode).map(unionNodeName)).toEqual(["fetch"]);
    expect(nodes.filter((n) => !isMovedNode(n)).map(unionNodeName)).toEqual([
      "agent",
      "step",
      "step",
    ]);
  });
});

describe("metricDirection", () => {
  it("reads lower as better, and ignores duration jitter", () => {
    expect(metricDirection("totalTokens", { baseline: 100, candidate: 90 })).toBe("better");
    expect(metricDirection("totalTokens", { baseline: 100, candidate: 120 })).toBe("worse");
    expect(metricDirection("totalTokens", { baseline: 100, candidate: 100 })).toBeNull();
    expect(metricDirection("cost", { baseline: 0.01, candidate: 0.01 + 1e-12 })).toBeNull();
    expect(metricDirection("cost", { baseline: 0.01, candidate: 0.02 })).toBe("worse");
    // 1000ms → 1080ms is jitter; 1000ms → 1600ms is a change.
    expect(metricDirection("durationMs", { baseline: 1000, candidate: 1080 })).toBeNull();
    expect(metricDirection("durationMs", { baseline: 1000, candidate: 1600 })).toBe("worse");
    expect(metricDirection("durationMs", { baseline: 1000, candidate: 400 })).toBe("better");
  });

  it("has no direction when either side is unknown", () => {
    expect(metricDirection("totalTokens", { baseline: null, candidate: 90 })).toBeNull();
    expect(metricDirection("durationMs", { baseline: 1000, candidate: null })).toBeNull();
  });
});

describe("traceUnion on a retried call", () => {
  // A candidate whose `agent` span was never exported: its children name it as their
  // parent and carry it in their recorded path, so it is drawn as a placeholder.
  const under = (name: string) => ({
    metadata: JSON.stringify({
      "traceroot.span.ids_path": ["c-eval", "c-task", "c-agent"],
      "traceroot.span.path": ["evaluation-item", "task", "agent", name],
    }),
  });

  it("adds the failed first call, pairs the rest and leaves the judge out of the counts", () => {
    const baseline = traceOf(
      "tb",
      trace([
        ["b-eval", null, "evaluation-item", SpanKind.EVALUATION],
        ["b-task", "b-eval", "task", SpanKind.TASK],
        ["b-agent", "b-task", "agent", SpanKind.AGENT],
        ["b-s1", "b-agent", "web_search", SpanKind.TOOL],
        ["b-s2", "b-agent", "web_search", SpanKind.TOOL],
        ["b-answer", "b-agent", "compose_answer", SpanKind.LLM, { total_tokens: 1200 }],
        ["b-quality", "b-eval", "quality", SpanKind.SCORER],
        ["b-judge", "b-quality", "judge", SpanKind.LLM, { total_tokens: 500 }],
      ]),
    );
    const candidate = traceOf(
      "tc",
      trace([
        ["c-eval", null, "evaluation-item", SpanKind.EVALUATION],
        ["c-task", "c-eval", "task", SpanKind.TASK],
        [
          "c-s1",
          "c-agent",
          "web_search",
          SpanKind.TOOL,
          { ...under("web_search"), status: SpanStatus.ERROR },
        ],
        ["c-s2", "c-agent", "web_search", SpanKind.TOOL, under("web_search")],
        ["c-s3", "c-agent", "web_search", SpanKind.TOOL, under("web_search")],
        [
          "c-answer",
          "c-agent",
          "compose_answer",
          SpanKind.LLM,
          { ...under("compose_answer"), total_tokens: 1900 },
        ],
        ["c-quality", "c-eval", "quality", SpanKind.SCORER],
        ["c-judge", "c-quality", "judge", SpanKind.LLM, { total_tokens: 530 }],
      ]),
    );

    const { nodes } = traceUnion(baseline, candidate);
    const byCandidate = (id: string) => nodes.find((n) => n.candidate?.span_id === id)!;
    const byBaseline = (id: string) => nodes.find((n) => n.baseline?.span_id === id)!;

    // The failed first call is added; the second and third pair with the first and second.
    expect(byCandidate("c-s1").state).toBe("added");
    expect(byCandidate("c-s2").baseline?.span_id).toBe("b-s1");
    expect(byCandidate("c-s3").baseline?.span_id).toBe("b-s2");

    // The placeholder pairs with the baseline's agent and is not a change.
    const agent = byBaseline("b-agent");
    expect(agent.state).toBe("matched");
    expect(agent.candidate?.span_id).toBe("c-agent");
    expect(agent.candidate?.pending).toBe(true);
    expect(agent.changed).toBe(false);

    const third = byCandidate("c-s3");
    expect(third.state === "matched" && describeMatchReason(third.reason)).toBe(
      "Matched by path: evaluation-item \u203a task \u203a agent \u203a tool:web_search #2 \u2192 #3",
    );

    // The judge's extra tokens belong to the evaluation; the answer's are the run's.
    expect(byBaseline("b-judge").evaluator).toBe(true);
    expect(byBaseline("b-judge").changed).toBe(false);
    expect(byBaseline("b-answer").changed).toBe(true);

    expect(divergenceCounts(nodes)).toEqual({ matched: 6, added: 1, removed: 0 });
  });
});
