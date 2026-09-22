import { describe, expect, it } from "vitest";
import { buildJevState } from "../jev-state.js";

/** A full `spans` row as the backend's spans-jsonl route serializes it (`SELECT *`). */
function row(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    span_id: "span-1",
    trace_id: "trace-abc",
    parent_span_id: null,
    project_id: "proj-1",
    span_start_time: "2026-09-21T20:00:00.000000",
    span_end_time: "2026-09-21T20:00:01.500000",
    name: "agent.run",
    span_kind: "AGENT",
    status: "OK",
    status_message: null,
    model_name: null,
    cost: 0.0012,
    input_tokens: 120,
    output_tokens: 45,
    total_tokens: 165,
    input: '{"task":"Look up weather in Paris"}',
    output: '"It is sunny in Paris."',
    metadata: '{"user_id":"u-1"}',
    git_source_file: "agent.py",
    git_source_line: 42,
    git_source_function: "run",
    ch_create_time: "2026-09-21T20:00:02.000000",
    ch_update_time: "2026-09-21T20:00:02.000000",
    environment: "production",
    usage_details: { cache_read_tokens: 10 },
    source: "user",
    is_evaluation: 0,
    ...overrides,
  };
}

function jsonl(rows: Array<Record<string, unknown>>): string {
  return rows.map((r) => JSON.stringify(r)).join("\n");
}

type Trace = { trace_id: string | null; span_count: number; spans: Array<Record<string, unknown>> };
function traceOf(state: unknown): Trace {
  return (state as { trace: Trace }).trace;
}

describe("buildJevState projection", () => {
  it("wraps spans as { trace: { trace_id, span_count, spans } }", () => {
    const { state, stats } = buildJevState(jsonl([row(), row({ span_id: "span-2", name: "llm" })]));
    const trace = traceOf(state);
    expect(Object.keys(state as object)).toEqual(["trace"]);
    expect(trace.trace_id).toBe("trace-abc");
    expect(trace.span_count).toBe(2);
    expect(trace.spans.map((s) => s.name)).toEqual(["agent.run", "llm"]);
    expect(stats.span_count).toBe(2);
    expect(stats.kept_spans).toBe(2);
    expect(stats.omitted_spans).toBe(0);
  });

  it("drops ids, timestamps, cost and token columns and internal flags", () => {
    const [span] = traceOf(buildJevState(jsonl([row()])).state).spans;
    expect(Object.keys(span)).toEqual([
      "name",
      "span_kind",
      "status",
      "input",
      "output",
      "metadata",
      "environment",
      "git_source_file",
      "git_source_line",
      "git_source_function",
    ]);
  });

  it("parses JSON-string payloads and keeps non-JSON text as-is", () => {
    const spans = traceOf(
      buildJevState(
        jsonl([
          row(),
          row({ input: "plain prompt text", output: "{not json", metadata: "[1,2]" }),
          row({ input: "true", output: "123" }),
        ]),
      ).state,
    ).spans;
    expect(spans[0].input).toEqual({ task: "Look up weather in Paris" });
    expect(spans[0].output).toBe("It is sunny in Paris.");
    expect(spans[0].metadata).toEqual({ user_id: "u-1" });
    expect(spans[1].input).toBe("plain prompt text");
    expect(spans[1].output).toBe("{not json");
    expect(spans[1].metadata).toEqual([1, 2]);
    // Bare scalars stay text: only objects, arrays and quoted strings are parsed.
    expect(spans[2].input).toBe("true");
    expect(spans[2].output).toBe("123");
  });

  it("omits null and empty columns and keeps status_message and model_name when set", () => {
    const [span] = traceOf(
      buildJevState(
        jsonl([
          row({
            status: "ERROR",
            status_message: "HTTP 503",
            model_name: "gpt-4o",
            metadata: null,
            environment: "",
          }),
        ]),
      ).state,
    ).spans;
    expect(span.status).toBe("ERROR");
    expect(span.status_message).toBe("HTTP 503");
    expect(span.model_name).toBe("gpt-4o");
    expect(span).not.toHaveProperty("metadata");
    expect(span).not.toHaveProperty("environment");
  });

  it("skips blank and unparseable lines and counts the bad ones", () => {
    const text = `${JSON.stringify(row())}\n\nnot json\n[1,2]\n${JSON.stringify(row({ name: "b" }))}\n`;
    const { state, stats } = buildJevState(text);
    expect(traceOf(state).spans.map((s) => s.name)).toEqual(["agent.run", "b"]);
    expect(stats.skipped_lines).toBe(2);
  });

  it("handles a row without trace_id", () => {
    const trace = traceOf(buildJevState("{}").state);
    expect(trace).toEqual({ trace_id: null, span_count: 1, spans: [{}] });
  });
});

describe("buildJevState reduction", () => {
  it("truncates inputs first, at the loosest cap that fits", () => {
    const bigInput = "x".repeat(20_000);
    const rows = [row({ input: bigInput }), row({ name: "small", input: '"short"' })];
    const { state, stats } = buildJevState(jsonl(rows), { budgetChars: 12_000 });
    const spans = traceOf(state).spans;
    expect(stats.input_cap_chars).toBe(8_000);
    expect(stats.truncated_inputs).toBe(1);
    expect(stats.dropped_metadata).toBe(0);
    expect(stats.omitted_spans).toBe(0);
    expect(spans[0].input).toBe(`${"x".repeat(8_000)}…[truncated 12000 chars]`);
    expect(spans[1].input).toBe("short");
    // Outputs and metadata are untouched at this stage.
    expect(spans[0].output).toBe("It is sunny in Paris.");
    expect(spans[0].metadata).toEqual({ user_id: "u-1" });
    expect(stats.final_chars).toBeLessThanOrEqual(12_000);
  });

  it("truncates a huge status_message at the same cap as inputs", () => {
    const rows = [row({ status: "ERROR", status_message: "s".repeat(50_000) })];
    const { state, stats } = buildJevState(jsonl(rows), { budgetChars: 12_000 });
    const [span] = traceOf(state).spans;
    expect(stats.input_cap_chars).toBe(8_000);
    expect(stats.truncated_status_messages).toBe(1);
    expect(stats.truncated_inputs).toBe(0);
    expect(stats.dropped_metadata).toBe(0);
    expect(stats.omitted_spans).toBe(0);
    expect(span.status_message).toBe(`${"s".repeat(8_000)}\u2026[truncated 42000 chars]`);
    expect(stats.final_chars).toBeLessThanOrEqual(12_000);
  });

  it("drops metadata once the tightest input cap is not enough", () => {
    const bigMeta = JSON.stringify({ blob: "m".repeat(3_000) });
    const rows = [row({ metadata: bigMeta }), row({ span_id: "s2", metadata: bigMeta })];
    const { state, stats } = buildJevState(jsonl(rows), { budgetChars: 2_000 });
    const spans = traceOf(state).spans;
    expect(stats.dropped_metadata).toBe(1);
    expect(stats.omitted_spans).toBe(0);
    expect(stats.input_cap_chars).toBe(200);
    for (const span of spans) {
      for (const col of [
        "metadata",
        "environment",
        "git_source_file",
        "git_source_line",
        "git_source_function",
      ]) {
        expect(span).not.toHaveProperty(col);
      }
      expect(span.output).toBe("It is sunny in Paris.");
    }
    expect(stats.final_chars).toBeLessThanOrEqual(2_000);
  });

  it("drops middle spans behind an omitted_spans marker, keeping head and tail", () => {
    const rows = Array.from({ length: 10 }, (_, i) =>
      row({ span_id: `s${i}`, name: `span-${i}`, output: JSON.stringify("o".repeat(400)) }),
    );
    // The spans are uniform and cost 3,370 chars together once reduced, so this
    // budget leaves room for exactly nine of them.
    const { state, stats } = buildJevState(jsonl(rows), { budgetChars: 3_200 });
    const trace = traceOf(state);
    expect(trace.span_count).toBe(10);
    expect(stats.kept_spans).toBe(9);
    expect(stats.omitted_spans).toBe(1);
    expect(trace.spans.map((s) => ("omitted_spans" in s ? s : s.name))).toEqual([
      "span-0",
      "span-1",
      "span-2",
      "span-3",
      "span-4",
      { omitted_spans: 1 },
      "span-6",
      "span-7",
      "span-8",
      "span-9",
    ]);
    // The incremental size arithmetic matches the real serialization.
    expect(stats.final_chars).toBe(JSON.stringify(state).length);
    expect(stats.final_chars).toBeLessThanOrEqual(3_200);
    // Span dropping only runs after the earlier stages.
    expect(stats.dropped_metadata).toBe(1);
  });

  it("truncates a large first-span output head and tail before dropping spans", () => {
    const output = JSON.stringify(`${"h".repeat(3_000)}${"t".repeat(3_000)}`);
    const rows = [row({ output }), row({ span_id: "s2", output })];
    const { state, stats } = buildJevState(jsonl(rows), { budgetChars: 1_000 });
    const spans = traceOf(state).spans;
    const cap = 200;
    expect(stats.omitted_spans).toBe(0);
    expect(stats.dropped_metadata).toBe(1);
    expect(stats.output_cap_chars).toBe(cap);
    expect(stats.truncated_outputs).toBe(2);
    expect(spans[0].output).toBe(
      `${"h".repeat(cap / 2)}…[truncated ${6_000 - cap} chars]…${"t".repeat(cap / 2)}`,
    );
    expect(stats.final_chars).toBe(JSON.stringify(state).length);
    expect(stats.final_chars).toBeLessThanOrEqual(1_000);
  });

  it("throws a clear error when even the first span alone is over budget", () => {
    const rows = [
      row({ output: JSON.stringify("o".repeat(5_000)) }),
      row({ span_id: "s2", output: JSON.stringify("o".repeat(5_000)) }),
    ];
    expect(() => buildJevState(jsonl(rows), { budgetChars: 150 })).toThrow(
      /Jev state does not fit the 150-char budget.*2 spans/,
    );
  });
});
