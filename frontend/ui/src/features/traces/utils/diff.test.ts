import { describe, expect, it } from "vitest";
import { SpanKind, SpanStatus } from "@traceroot/core";
import { buildUnionTree, metricDirection, traceUnion } from "@/lib/eval/union-tree";
import type { Span, TraceDetail } from "@/types/api";
import {
  beforeAfter,
  diffScaleMs,
  findUnionNode,
  moveClass,
  traceFigures,
  unionBars,
} from "./diff";

const span = (traceId: string, id: string, parent: string | null, name: string): Span => ({
  span_id: id,
  trace_id: traceId,
  parent_span_id: parent,
  name,
  span_kind: SpanKind.SPAN,
  span_start_time: "2026-11-01T10:00:00.000Z",
  span_end_time: "2026-11-01T10:00:01.000Z",
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
});

describe("findUnionNode", () => {
  // Both traces reuse the same span ids, as two runs replaying one recording can.
  const baseline = [span("tb", "root", null, "agent"), span("tb", "s1", "root", "search")];
  const candidate = [span("tc", "root", null, "agent"), span("tc", "s1", "root", "answer")];
  const { nodes } = buildUnionTree(baseline, candidate);

  it("finds a candidate span's node by its candidate id", () => {
    expect(findUnionNode(nodes, candidate[1], "tb")?.id).toBe("candidate:s1");
    expect(findUnionNode(nodes, candidate[0], "tb")?.id).toBe("baseline:root");
  });

  it("finds a span only the baseline has by its baseline id", () => {
    expect(findUnionNode(nodes, baseline[1], "tb")?.id).toBe("baseline:s1");
  });

  it("finds nothing for a span neither trace has", () => {
    expect(findUnionNode(nodes, span("tc", "gone", null, "x"), "tb")).toBeNull();
    // Another trace's span, though this one reuses its id: an old baseline's, say.
    expect(findUnionNode(nodes, span("other", "s1", null, "x"), "tb")).toBeNull();
  });
});

describe("beforeAfter and moveClass", () => {
  it("reads a figure on the baseline, then on this trace, dashing a side with none", () => {
    const ms = (n: number) => `${n}ms`;
    expect(beforeAfter({ baseline: 100, candidate: 80 }, ms)).toBe("100ms → 80ms");
    expect(beforeAfter({ baseline: null, candidate: 80 }, ms)).toBe("— → 80ms");
  });

  it("colours better green, worse red and anything else muted", () => {
    expect(moveClass("better")).toBe("text-success");
    expect(moveClass("worse")).toBe("text-danger");
    expect(moveClass(null)).toBe("text-muted-foreground");
  });
});

describe("traceFigures", () => {
  it("reads — for this trace's tokens while none of its spans has reported usage, not a drop to 0", () => {
    const baseline = {
      spans: [{ ...span("tb", "b0", null, "agent"), total_tokens: 1700 }],
    } as TraceDetail;
    // A streaming span that hasn't reported usage arrives without the usage keys.
    const streamed: Partial<Span> = span("tc", "c0", null, "agent");
    delete streamed.input_tokens;
    delete streamed.output_tokens;
    delete streamed.total_tokens;
    const trace = { spans: [streamed as Span] } as TraceDetail;

    const { totalTokens } = traceFigures(baseline, trace);
    expect(totalTokens).toEqual({ baseline: 1700, candidate: null });
    expect(beforeAfter(totalTokens, String)).toBe("1700 → —");
    expect(metricDirection("totalTokens", totalTokens)).toBeNull();
  });
});

describe("unionBars", () => {
  const T0 = Date.UTC(2026, 10, 1, 10);
  const timed = (s: Span, start: number, end: number | null): Span => ({
    ...s,
    span_start_time: new Date(T0 + start).toISOString(),
    span_end_time: end === null ? null : new Date(T0 + end).toISOString(),
  });
  const traceOf = (traceId: string, spans: Span[]): TraceDetail => ({
    trace_id: traceId,
    project_id: "p1",
    name: "agent",
    trace_start_time: spans[0].span_start_time,
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
  // The baseline started an hour earlier; each run is measured from its own start.
  const HOUR = 3_600_000;
  const baseline = traceOf("tb", [
    timed(span("tb", "b0", null, "agent"), -HOUR, -HOUR + 1000),
    timed(span("tb", "b1", "b0", "search"), -HOUR + 110, -HOUR + 200),
  ]);
  const candidate = traceOf("tc", [
    timed(span("tc", "c0", null, "agent"), 0, 1600),
    timed(span("tc", "c1", "c0", "answer"), 110, 400),
    timed(span("tc", "c2", "c0", "stream"), 500, null),
  ]);
  const { nodes } = traceUnion(baseline, candidate);

  it("places this trace's span as the bar and the baseline's as the ghost behind it", () => {
    const bars = unionBars(nodes);
    const byName = (name: string) =>
      bars.get(nodes.find((n) => (n.candidate ?? n.baseline)!.name === name)!.id);
    expect(byName("agent")).toEqual({
      bar: { offsetMs: 0, durationMs: 1600, inProgress: false },
      ghost: { offsetMs: 0, durationMs: 1000, inProgress: false },
    });
    // Only the baseline searched: a ghost alone.
    expect(byName("search")).toEqual({
      bar: null,
      ghost: { offsetMs: 110, durationMs: 90, inProgress: false },
    });
    expect(byName("answer")).toEqual({
      bar: { offsetMs: 110, durationMs: 290, inProgress: false },
      ghost: null,
    });
    expect(byName("stream")?.bar?.inProgress).toBe(true);
  });

  it("scales the timeline to the longer of the two runs", () => {
    // Both finished, so neither is measured against the clock.
    const longer = traceOf("tc2", [timed(span("tc2", "c0", null, "agent"), 0, 1600)]);
    expect(diffScaleMs(longer, baseline)).toBe(1600);
    const short = traceOf("ts", [timed(span("ts", "s0", null, "agent"), 0, 500)]);
    expect(
      diffScaleMs(short, traceOf("tb2", [timed(span("tb2", "x", null, "agent"), 0, 900)])),
    ).toBe(900);
  });
});
