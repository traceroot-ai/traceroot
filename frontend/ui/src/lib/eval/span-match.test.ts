import { describe, it, expect } from "vitest";
import { SpanKind, SpanStatus } from "@traceroot/core";
import type { Span } from "@/types/api";
import { describeMatchReason, matchSpans, type SpanMatch } from "./span-match";

const T0 = Date.UTC(2026, 0, 1);
const at = (ms: number) => new Date(T0 + ms).toISOString();

type Row = [
  id: string,
  parent: string | null,
  name: string,
  kind?: Span["span_kind"],
  extra?: Partial<Span>,
];

// Spans start 10ms apart in listed order, so siblings sort exactly as written.
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

const partner = (m: SpanMatch, candidateId: string) =>
  m.byCandidateId.get(candidateId)?.baseline.span_id;
const ids = (spans: Span[]) => spans.map((s) => s.span_id);

describe("matchSpans", () => {
  it("matches every span of two identical traces by path", () => {
    const baseline = trace([
      ["b-root", null, "agent", SpanKind.AGENT],
      ["b-plan", "b-root", "plan", SpanKind.LLM],
      ["b-search", "b-root", "web_search", SpanKind.TOOL],
      ["b-answer", "b-root", "answer", SpanKind.LLM],
    ]);
    const candidate = trace([
      ["c-root", null, "agent", SpanKind.AGENT],
      ["c-plan", "c-root", "plan", SpanKind.LLM],
      ["c-search", "c-root", "web_search", SpanKind.TOOL],
      ["c-answer", "c-root", "answer", SpanKind.LLM],
    ]);

    const m = matchSpans(baseline, candidate);

    expect(m.pairs).toHaveLength(4);
    expect(m.added).toEqual([]);
    expect(m.removed).toEqual([]);
    expect(partner(m, "c-root")).toBe("b-root");
    expect(partner(m, "c-search")).toBe("b-search");
    expect(m.byBaselineId.get("b-answer")?.candidate.span_id).toBe("c-answer");
    expect(m.byCandidateId.get("c-search")?.reason).toEqual({
      basis: "path",
      path: ["agent", "web_search"],
      spanKind: SpanKind.TOOL,
      ordinal: { baseline: 1, candidate: 1 },
    });
  });

  it("does not depend on the order spans arrive in", () => {
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

    const m = matchSpans([...baseline].reverse(), [...candidate].reverse());

    expect(partner(m, "c-1")).toBe("b-1");
    expect(partner(m, "c-2")).toBe("b-2");
  });

  it("reports an extra tool span in the candidate as added", () => {
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

    const m = matchSpans(baseline, candidate);

    expect(ids(m.added)).toEqual(["c-search"]);
    expect(m.removed).toEqual([]);
    expect(partner(m, "c-plan")).toBe("b-plan");
    expect(partner(m, "c-answer")).toBe("b-answer");
  });

  it("reports a span the candidate dropped as removed", () => {
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

    const m = matchSpans(baseline, candidate);

    expect(ids(m.removed)).toEqual(["b-fetch"]);
    expect(m.added).toEqual([]);
    expect(partner(m, "c-search")).toBe("b-search");
  });

  it("aligns reordered siblings with the same names", () => {
    const baseline = trace([
      ["b-root", null, "agent", SpanKind.AGENT],
      ["b-search", "b-root", "web_search", SpanKind.TOOL],
      ["b-read", "b-root", "read_file", SpanKind.TOOL],
      ["b-answer", "b-root", "answer", SpanKind.LLM],
    ]);
    const candidate = trace([
      ["c-root", null, "agent", SpanKind.AGENT],
      ["c-read", "c-root", "read_file", SpanKind.TOOL],
      ["c-search", "c-root", "web_search", SpanKind.TOOL],
      ["c-answer", "c-root", "answer", SpanKind.LLM],
    ]);

    const m = matchSpans(baseline, candidate);

    expect(m.added).toEqual([]);
    expect(m.removed).toEqual([]);
    expect(partner(m, "c-search")).toBe("b-search");
    expect(partner(m, "c-read")).toBe("b-read");
    expect(partner(m, "c-answer")).toBe("b-answer");
  });

  it("pairs repeated same-name siblings by their ordinal", () => {
    const baseline = trace([
      ["b-root", null, "agent", SpanKind.AGENT],
      ["b-1", "b-root", "web_search", SpanKind.TOOL],
      ["b-2", "b-root", "web_search", SpanKind.TOOL],
      ["b-3", "b-root", "web_search", SpanKind.TOOL],
    ]);
    const candidate = trace([
      ["c-root", null, "agent", SpanKind.AGENT],
      ["c-1", "c-root", "web_search", SpanKind.TOOL],
      ["c-2", "c-root", "web_search", SpanKind.TOOL],
      ["c-3", "c-root", "web_search", SpanKind.TOOL],
    ]);

    const m = matchSpans(baseline, candidate);

    expect(partner(m, "c-1")).toBe("b-1");
    expect(partner(m, "c-2")).toBe("b-2");
    expect(partner(m, "c-3")).toBe("b-3");
    expect(m.byCandidateId.get("c-2")?.reason.ordinal).toEqual({ baseline: 2, candidate: 2 });
  });

  it("leaves a failed attempt the candidate retried unmatched, keeping the later ones aligned", () => {
    // The failed call was retried, so the attempts after it are the ones that line up
    // with the baseline's.
    const baseline = trace([
      ["b-root", null, "agent", SpanKind.AGENT],
      ["b-read", "b-root", "read_logs", SpanKind.TOOL],
      ["b-cl1", "b-root", "classify", SpanKind.LLM],
      ["b-cl2", "b-root", "classify", SpanKind.LLM],
    ]);
    const candidate = trace([
      ["c-root", null, "agent", SpanKind.AGENT],
      ["c-read", "c-root", "read_logs", SpanKind.TOOL],
      ["c-cl1", "c-root", "classify", SpanKind.LLM, { status: SpanStatus.ERROR }],
      ["c-cl2", "c-root", "classify", SpanKind.LLM],
      ["c-cl3", "c-root", "classify", SpanKind.LLM],
    ]);

    const m = matchSpans(baseline, candidate);

    expect(partner(m, "c-cl3")).toBe("b-cl2");
    expect(partner(m, "c-cl2")).toBe("b-cl1");
    expect(ids(m.added)).toEqual(["c-cl1"]);
    expect(m.byCandidateId.get("c-cl3")?.reason.ordinal).toEqual({ baseline: 2, candidate: 3 });
  });

  it("does not match a renamed span", () => {
    const baseline = trace([
      ["b-root", null, "agent", SpanKind.AGENT],
      ["b-search", "b-root", "web_search", SpanKind.TOOL],
      ["b-answer", "b-root", "answer", SpanKind.LLM],
    ]);
    const candidate = trace([
      ["c-root", null, "agent", SpanKind.AGENT],
      ["c-search", "c-root", "web_search", SpanKind.TOOL],
      ["c-answer", "c-root", "final_answer", SpanKind.LLM],
    ]);

    const m = matchSpans(baseline, candidate);

    expect(ids(m.added)).toEqual(["c-answer"]);
    expect(ids(m.removed)).toEqual(["b-answer"]);
    expect(m.byCandidateId.has("c-answer")).toBe(false);
  });

  it("does not match spans whose kind changed", () => {
    const baseline = trace([
      ["b-root", null, "agent", SpanKind.AGENT],
      ["b-x", "b-root", "lookup", SpanKind.TOOL],
    ]);
    const candidate = trace([
      ["c-root", null, "agent", SpanKind.AGENT],
      ["c-x", "c-root", "lookup", SpanKind.LLM],
    ]);

    const m = matchSpans(baseline, candidate);

    expect(ids(m.added)).toEqual(["c-x"]);
    expect(ids(m.removed)).toEqual(["b-x"]);
  });

  it("leaves the whole subtree of a renamed parent removed and added", () => {
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

    const m = matchSpans(baseline, candidate);

    expect(m.pairs.map((p) => p.candidate.span_id)).toEqual(["c-root"]);
    expect(ids(m.added)).toEqual(["c-plan", "c-search", "c-fetch"]);
    expect(ids(m.removed)).toEqual(["b-plan", "b-search", "b-fetch"]);
  });

  it("does not pair same-named spans that sit in different subtrees", () => {
    // compose_answer moved out of research to the top level: a different place in the
    // run, so it reads as removed there and added here.
    const baseline = trace([
      ["b-root", null, "agent", SpanKind.AGENT],
      ["b-research", "b-root", "research", SpanKind.AGENT],
      ["b-compose", "b-research", "compose_answer", SpanKind.LLM],
    ]);
    const candidate = trace([
      ["c-root", null, "agent", SpanKind.AGENT],
      ["c-research", "c-root", "research", SpanKind.AGENT],
      ["c-compose", "c-root", "compose_answer", SpanKind.LLM],
    ]);

    const m = matchSpans(baseline, candidate);

    expect(partner(m, "c-research")).toBe("b-research");
    expect(m.byCandidateId.has("c-compose")).toBe(false);
    expect(ids(m.removed)).toEqual(["b-compose"]);
    expect(ids(m.added)).toEqual(["c-compose"]);
  });

  it("keeps a dropped span and an unrelated same-named span elsewhere apart", () => {
    const baseline = trace([
      ["b-root", null, "agent", SpanKind.AGENT],
      ["b-search", "b-root", "web_search", SpanKind.TOOL],
      ["b-sum", "b-search", "summarize", SpanKind.LLM],
      ["b-answer", "b-root", "answer", SpanKind.LLM],
    ]);
    const candidate = trace([
      ["c-root", null, "agent", SpanKind.AGENT],
      ["c-search", "c-root", "web_search", SpanKind.TOOL],
      ["c-answer", "c-root", "answer", SpanKind.LLM],
      ["c-sum", "c-answer", "summarize", SpanKind.LLM],
    ]);

    const m = matchSpans(baseline, candidate);

    expect(partner(m, "c-search")).toBe("b-search");
    expect(partner(m, "c-answer")).toBe("b-answer");
    expect(ids(m.removed)).toEqual(["b-sum"]);
    expect(ids(m.added)).toEqual(["c-sum"]);
  });

  it("matches a stranded subtree by its full path, not an earlier same-named span", () => {
    // The candidate's first `step` failed and was retried; that attempt is left
    // unmatched, which strands its `fetch` child. That child must pair with the
    // baseline `fetch` at the same path, not the earlier `fetch` under `decoy`.
    const baseline = trace([
      ["b-root", null, "agent", SpanKind.AGENT],
      ["b-step", "b-root", "step"],
      ["b-fetch", "b-step", "fetch", SpanKind.TOOL],
    ]);
    const candidate = trace([
      ["c-root", null, "agent", SpanKind.AGENT],
      ["c-decoy", "c-root", "decoy"],
      ["c-decoy-fetch", "c-decoy", "fetch", SpanKind.TOOL],
      ["c-step1", "c-root", "step", undefined, { status: SpanStatus.ERROR }],
      ["c-fetch", "c-step1", "fetch", SpanKind.TOOL],
      ["c-step2", "c-root", "step"],
    ]);

    const m = matchSpans(baseline, candidate);

    expect(partner(m, "c-step2")).toBe("b-step");
    expect(partner(m, "c-fetch")).toBe("b-fetch");
    expect(m.byCandidateId.get("c-fetch")?.reason.basis).toBe("path");
    expect(ids(m.added)).toEqual(["c-decoy", "c-decoy-fetch", "c-step1"]);
    // It is drawn under the baseline's step, but ran under the failed attempt.
    expect(m.byCandidateId.get("c-fetch")?.reason.candidateParent).toEqual({
      name: "step",
      ordinal: 1,
    });
    expect(describeMatchReason(m.byCandidateId.get("c-fetch")!.reason)).toBe(
      "Matched by path: agent › step › tool:fetch #1 · in the candidate it sits under step #1",
    );
    expect(m.byCandidateId.get("c-step2")?.reason.candidateParent).toBeUndefined();
  });

  it("pairs the two roots even when their names differ", () => {
    const baseline = trace([
      ["b-root", null, "run-a", SpanKind.EVALUATION],
      ["b-task", "b-root", "task", SpanKind.TASK],
    ]);
    const candidate = trace([
      ["c-root", null, "run-b", SpanKind.EVALUATION],
      ["c-task", "c-root", "task", SpanKind.TASK],
    ]);

    const m = matchSpans(baseline, candidate);

    expect(partner(m, "c-root")).toBe("b-root");
    expect(m.byCandidateId.get("c-root")?.reason.basis).toBe("root");
    expect(partner(m, "c-task")).toBe("b-task");
    expect(m.byCandidateId.get("c-task")?.reason.basis).toBe("path");
  });

  it("matches a stranded subtree by path under a renamed root", () => {
    // Same retry shape as above, but the root name differs between the runs: the
    // stranded `fetch` still pairs, since paths compare below the paired roots.
    const baseline = trace([
      ["b-root", null, "run-a", SpanKind.EVALUATION],
      ["b-step", "b-root", "step"],
      ["b-fetch", "b-step", "fetch", SpanKind.TOOL],
    ]);
    const candidate = trace([
      ["c-root", null, "run-b", SpanKind.EVALUATION],
      ["c-step1", "c-root", "step", undefined, { status: SpanStatus.ERROR }],
      ["c-fetch", "c-step1", "fetch", SpanKind.TOOL],
      ["c-step2", "c-root", "step"],
    ]);

    const m = matchSpans(baseline, candidate);

    expect(partner(m, "c-step2")).toBe("b-step");
    expect(partner(m, "c-fetch")).toBe("b-fetch");
    expect(m.byCandidateId.get("c-fetch")?.reason.basis).toBe("path");
    expect(ids(m.added)).toEqual(["c-step1"]);
  });

  it("treats an empty-string parent as a root", () => {
    const baseline = trace([
      ["b-root", "", "agent", SpanKind.AGENT],
      ["b-task", "b-root", "task", SpanKind.TASK],
    ]);
    const candidate = trace([
      ["c-root", "", "agent", SpanKind.AGENT],
      ["c-task", "c-root", "task", SpanKind.TASK],
    ]);

    const m = matchSpans(baseline, candidate);

    expect(partner(m, "c-root")).toBe("b-root");
    expect(partner(m, "c-task")).toBe("b-task");
  });

  it("reads the logical path the SDK recorded when the parent never arrived", () => {
    const sdkPath = (path: string[]) => ({
      metadata: JSON.stringify({ "traceroot.span.path": path }),
    });
    const baseline = trace([
      ["b-root", null, "agent", SpanKind.AGENT],
      [
        "b-search",
        "b-missing",
        "web_search",
        SpanKind.TOOL,
        sdkPath(["agent", "plan", "web_search"]),
      ],
    ]);
    const candidate = trace([
      ["c-root", null, "agent", SpanKind.AGENT],
      [
        "c-search",
        "c-missing",
        "web_search",
        SpanKind.TOOL,
        sdkPath(["agent", "plan", "web_search"]),
      ],
    ]);

    const m = matchSpans(baseline, candidate);

    expect(partner(m, "c-search")).toBe("b-search");
    expect(m.byCandidateId.get("c-search")?.reason.path).toEqual(["agent", "plan", "web_search"]);
  });

  it("derives the logical path from the parent chain when metadata has none", () => {
    const baseline = trace([
      ["b-root", null, "agent", SpanKind.AGENT],
      ["b-plan", "b-root", "plan"],
      ["b-search", "b-plan", "web_search", SpanKind.TOOL, { metadata: "not json" }],
    ]);
    const candidate = trace([
      ["c-root", null, "agent", SpanKind.AGENT],
      ["c-plan", "c-root", "plan"],
      ["c-search", "c-plan", "web_search", SpanKind.TOOL, { metadata: null }],
    ]);

    const m = matchSpans(baseline, candidate);

    expect(m.byCandidateId.get("c-search")?.reason.path).toEqual(["agent", "plan", "web_search"]);
  });

  it("handles empty and one-sided traces", () => {
    const one = trace([
      ["x-root", null, "agent", SpanKind.AGENT],
      ["x-tool", "x-root", "web_search", SpanKind.TOOL],
    ]);

    const none = matchSpans([], []);
    expect(none.pairs).toEqual([]);
    expect(none.added).toEqual([]);
    expect(none.removed).toEqual([]);

    const onlyCandidate = matchSpans([], one);
    expect(onlyCandidate.pairs).toEqual([]);
    expect(ids(onlyCandidate.added)).toEqual(["x-root", "x-tool"]);
    expect(onlyCandidate.removed).toEqual([]);

    const onlyBaseline = matchSpans(one, []);
    expect(onlyBaseline.pairs).toEqual([]);
    expect(onlyBaseline.added).toEqual([]);
    expect(ids(onlyBaseline.removed)).toEqual(["x-root", "x-tool"]);
  });

  it("survives a parent cycle in malformed data", () => {
    const baseline = trace([
      ["b-a", "b-b", "a"],
      ["b-b", "b-a", "b"],
    ]);
    const candidate = trace([
      ["c-a", "c-b", "a"],
      ["c-b", "c-a", "b"],
    ]);

    const m = matchSpans(baseline, candidate);

    expect(partner(m, "c-a")).toBe("b-a");
    expect(partner(m, "c-b")).toBe("b-b");
  });

  it("still pairs very wide sibling lists", () => {
    const wide = (prefix: string, count: number) =>
      trace([
        [`${prefix}-root`, null, "agent", SpanKind.AGENT],
        ...Array.from(
          { length: count },
          (_, i): Row => [`${prefix}-${i}`, `${prefix}-root`, "web_search", SpanKind.TOOL],
        ),
      ]);

    const m = matchSpans(wide("b", 1200), wide("c", 1200));

    expect(m.pairs).toHaveLength(1201);
    expect(partner(m, "c-0")).toBe("b-0");
    expect(partner(m, "c-1199")).toBe("b-1199");
  });
});

describe("matchSpans sibling alignment", () => {
  /** A root with these children, in this order. */
  const flat = (
    prefix: string,
    kids: Array<[name: string, kind: Span["span_kind"], extra?: Partial<Span>]>,
  ) =>
    trace([
      [`${prefix}-root`, null, "agent", SpanKind.AGENT],
      ...kids.map(
        ([name, kind, extra], i): Row => [`${prefix}-${i}`, `${prefix}-root`, name, kind, extra],
      ),
    ]);
  const steps = (prefix: string, n: number) =>
    flat(
      prefix,
      Array.from({ length: n }, () => ["step", SpanKind.AGENT] as [string, Span["span_kind"]]),
    );

  it("pairs a repeated step from the front when the candidate ran it once more", () => {
    const m = matchSpans(steps("b", 5), steps("c", 6));

    expect(ids(m.added)).toEqual(["c-5"]);
    for (let i = 0; i < 5; i++) expect(partner(m, `c-${i}`)).toBe(`b-${i}`);
  });

  it("drops the last iteration of a loop the candidate cut short, not the first", () => {
    const m = matchSpans(
      flat("b", [
        ["llm", SpanKind.LLM],
        ["tool", SpanKind.TOOL],
        ["llm", SpanKind.LLM],
        ["tool", SpanKind.TOOL],
        ["llm", SpanKind.LLM],
      ]),
      flat("c", [
        ["llm", SpanKind.LLM],
        ["tool", SpanKind.TOOL],
        ["llm", SpanKind.LLM],
      ]),
    );

    expect(partner(m, "c-0")).toBe("b-0");
    expect(partner(m, "c-1")).toBe("b-1");
    expect(partner(m, "c-2")).toBe("b-2");
    expect(ids(m.removed)).toEqual(["b-3", "b-4"]);
  });

  it("places an extra loop iteration in the middle where it ran", () => {
    const m = matchSpans(
      flat("b", [
        ["plan", SpanKind.LLM],
        ["llm", SpanKind.LLM],
        ["tool", SpanKind.TOOL],
        ["answer", SpanKind.LLM],
      ]),
      flat("c", [
        ["plan", SpanKind.LLM],
        ["llm", SpanKind.LLM],
        ["tool", SpanKind.TOOL],
        ["llm", SpanKind.LLM],
        ["tool", SpanKind.TOOL],
        ["answer", SpanKind.LLM],
      ]),
    );

    expect(partner(m, "c-1")).toBe("b-1");
    expect(partner(m, "c-2")).toBe("b-2");
    expect(ids(m.added)).toEqual(["c-3", "c-4"]);
    expect(partner(m, "c-5")).toBe("b-3");
  });

  it("prefers the attempt whose subtree matches when an earlier one's doesn't", () => {
    const baseline = trace([
      ["b-root", null, "agent", SpanKind.AGENT],
      ["b-step", "b-root", "step"],
      ["b-fetch", "b-step", "fetch", SpanKind.TOOL],
    ]);
    const candidate = trace([
      ["c-root", null, "agent", SpanKind.AGENT],
      ["c-step1", "c-root", "step"],
      ["c-step2", "c-root", "step"],
      ["c-fetch", "c-step2", "fetch", SpanKind.TOOL],
    ]);

    const m = matchSpans(baseline, candidate);

    expect(partner(m, "c-step2")).toBe("b-step");
    expect(partner(m, "c-fetch")).toBe("b-fetch");
    expect(m.byCandidateId.get("c-fetch")?.reason.candidateParent).toBeUndefined();
    expect(ids(m.added)).toEqual(["c-step1"]);
  });

  it("pairs failed attempts with each other when both runs retried as often", () => {
    const failed = { status: SpanStatus.ERROR };
    const m = matchSpans(
      flat("b", [
        ["call", SpanKind.LLM, failed],
        ["call", SpanKind.LLM],
      ]),
      flat("c", [
        ["call", SpanKind.LLM, failed],
        ["call", SpanKind.LLM],
      ]),
    );

    expect(partner(m, "c-0")).toBe("b-0");
    expect(partner(m, "c-1")).toBe("b-1");
  });

  it("aligns the same way past the alignment table's size limit", () => {
    // 1,000 × 1,001 siblings is past the table's limit, so pairing falls back to key order.
    const calls = (prefix: string, n: number, failedFirst: boolean) =>
      flat(prefix, [
        ...(failedFirst
          ? [
              ["call", SpanKind.LLM, { status: SpanStatus.ERROR }] as [
                string,
                Span["span_kind"],
                Partial<Span>,
              ],
            ]
          : []),
        ...Array.from({ length: n }, () => ["call", SpanKind.LLM] as [string, Span["span_kind"]]),
      ]);
    for (const n of [3, 1000]) {
      const extraLast = matchSpans(calls("b", n, false), calls("c", n + 1, false));
      expect(ids(extraLast.added)).toEqual([`c-${n}`]);
      const retried = matchSpans(calls("b", n, false), calls("c", n, true));
      expect(ids(retried.added)).toEqual(["c-0"]);
      expect(partner(retried, "c-1")).toBe("b-0");
    }
  });

  it("notes calls that ran in parallel, paired in start order", () => {
    const parallel = (prefix: string) =>
      trace([
        [`${prefix}-root`, null, "agent", SpanKind.AGENT, { span_end_time: at(500) }],
        ...[0, 1, 2].map(
          (i): Row => [
            `${prefix}-${i}`,
            `${prefix}-root`,
            "web_search",
            SpanKind.TOOL,
            { span_start_time: at(10 + i), span_end_time: at(200) },
          ],
        ),
        [
          `${prefix}-answer`,
          `${prefix}-root`,
          "answer",
          SpanKind.LLM,
          { span_start_time: at(300), span_end_time: at(400) },
        ],
      ]);

    const m = matchSpans(parallel("b"), parallel("c"));

    expect(partner(m, "c-1")).toBe("b-1");
    expect(m.byCandidateId.get("c-1")?.reason.parallel).toBe(3);
    expect(describeMatchReason(m.byCandidateId.get("c-1")!.reason)).toBe(
      "Matched by path: agent › tool:web_search #2 · one of 3 parallel web_search calls, paired by start order",
    );
    expect(m.byCandidateId.get("c-answer")?.reason.parallel).toBeUndefined();
  });

  it("hands back each side's children in display order", () => {
    const m = matchSpans([...steps("b", 2)].reverse(), steps("c", 1));

    expect(ids(m.baselineChildren.get("b-root") ?? [])).toEqual(["b-0", "b-1"]);
    expect(ids(m.candidateChildren.get(null) ?? [])).toEqual(["c-root"]);
  });
});

describe("describeMatchReason", () => {
  it("names the path and ordinal of a path match", () => {
    expect(
      describeMatchReason({
        basis: "path",
        path: ["agent", "web_search"],
        spanKind: SpanKind.TOOL,
        ordinal: { baseline: 2, candidate: 2 },
      }),
    ).toBe("Matched by path: agent › tool:web_search #2");
  });

  it("shows both ordinals when the alignment shifted them", () => {
    expect(
      describeMatchReason({
        basis: "path",
        path: ["agent", "classify"],
        spanKind: SpanKind.LLM,
        ordinal: { baseline: 2, candidate: 3 },
      }),
    ).toBe("Matched by path: agent › llm:classify #2 → #3");
  });

  it("describes the root pairing", () => {
    expect(
      describeMatchReason({
        basis: "root",
        path: ["run-a"],
        spanKind: SpanKind.EVALUATION,
        ordinal: { baseline: 1, candidate: 1 },
      }),
    ).toBe("Matched as the trace root");
  });
});
