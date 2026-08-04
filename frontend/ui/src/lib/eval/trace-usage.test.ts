import { describe, it, expect } from "vitest";
import { attributeTraceUsage, type UsageSpan } from "./trace-usage";

function span(
  id: string,
  parent: string | null,
  kind: string,
  u: Partial<UsageSpan> = {},
): UsageSpan {
  return {
    span_id: id,
    parent_span_id: parent,
    span_kind: kind,
    input_tokens: u.input_tokens ?? null,
    output_tokens: u.output_tokens ?? null,
    total_tokens: u.total_tokens ?? null,
    cost: u.cost ?? null,
  };
}

// The real SDK eval-trace shape: EVALUATION root → TASK (with an LLM leaf) + SCORER spans.
function evalTrace(opts: { judgeUsage?: boolean; scorerLlm?: boolean } = {}): UsageSpan[] {
  const spans: UsageSpan[] = [
    span("root", null, "EVALUATION"),
    span("task", "root", "TASK"),
    // The task's LLM leaf carries the application usage.
    span("task-llm", "task", "LLM", {
      input_tokens: 100,
      output_tokens: 20,
      total_tokens: 120,
      cost: 0.003,
    }),
    span("scorer-a", "root", "SCORER"),
    span("scorer-b", "root", "SCORER"),
  ];
  if (opts.scorerLlm) {
    // An LLM-judge scorer: its own LLM leaf carries the judge usage.
    spans.push(
      span("judge-llm", "scorer-a", "LLM", {
        input_tokens: opts.judgeUsage === false ? null : 40,
        output_tokens: opts.judgeUsage === false ? null : 5,
        total_tokens: opts.judgeUsage === false ? null : 45,
        cost: opts.judgeUsage === false ? null : 0.001,
      }),
    );
  }
  return spans;
}

describe("attributeTraceUsage", () => {
  it("is pending when there is no trace yet", () => {
    expect(attributeTraceUsage(null).state).toBe("pending");
    expect(attributeTraceUsage([]).state).toBe("pending");
  });

  it("is unknown when the trace has spans but no provider usage", () => {
    const u = attributeTraceUsage([span("root", null, "EVALUATION"), span("task", "root", "TASK")]);
    expect(u.state).toBe("unknown");
    expect(u.combined.totalTokens).toBe(0);
    expect(u.combined.spanCount).toBe(0);
  });

  it("attributes the task's LLM leaf to task cost (lab shape: non-LLM scorers)", () => {
    const u = attributeTraceUsage(evalTrace());
    expect(u.state).toBe("present");
    expect(u.task).toMatchObject({
      inputTokens: 100,
      outputTokens: 20,
      totalTokens: 120,
      cost: 0.003,
      spanCount: 1,
    });
    expect(u.scorer.spanCount).toBe(0); // non-LLM scorers → no judge cost
    expect(u.combined.totalTokens).toBe(120);
    expect(u.combined.cost).toBeCloseTo(0.003);
  });

  it("separates application (task) cost from evaluation-judge (scorer) cost", () => {
    const u = attributeTraceUsage(evalTrace({ scorerLlm: true }));
    expect(u.task.totalTokens).toBe(120);
    expect(u.task.cost).toBeCloseTo(0.003);
    expect(u.scorer).toMatchObject({ totalTokens: 45, cost: 0.001, spanCount: 1 });
    expect(u.combined.totalTokens).toBe(165);
    expect(u.combined.cost).toBeCloseTo(0.004);
  });

  it("never double-counts: wrapper TASK/SCORER/EVALUATION spans are not summed even if they carry usage", () => {
    const spans = [
      span("root", null, "EVALUATION", { total_tokens: 999, cost: 9.99 }), // wrapper — ignored
      span("task", "root", "TASK", { total_tokens: 999, cost: 9.99 }), // wrapper — ignored
      span("task-llm", "task", "LLM", {
        input_tokens: 10,
        output_tokens: 2,
        total_tokens: 12,
        cost: 0.001,
      }),
      span("nested", "task-llm", "LLM", {
        input_tokens: 5,
        output_tokens: 1,
        total_tokens: 6,
        cost: 0.0005,
      }),
    ];
    const u = attributeTraceUsage(spans);
    // Only the two LLM leaves count; the TASK/EVALUATION wrappers' fake usage is excluded.
    expect(u.task.totalTokens).toBe(18);
    expect(u.task.cost).toBeCloseTo(0.0015);
    expect(u.task.spanCount).toBe(2);
    expect(u.combined.totalTokens).toBe(18);
  });

  it("attributes an LLM span with no TASK wrapper to `task`, matching the backend", () => {
    // The backend's `_task_cost_by_trace` only excludes SCORER subtrees — everything
    // else (including a span with no TASK ancestor) counts as task cost. There is no
    // third "neither" bucket on either side, so this must land in `task` here too.
    const spans = [
      span("root", null, "EVALUATION"),
      span("loose-llm", "root", "LLM", { total_tokens: 30, cost: 0.002 }),
    ];
    const u = attributeTraceUsage(spans);
    expect(u.task.totalTokens).toBe(30);
    expect(u.task.spanCount).toBe(1);
    expect(u.scorer.spanCount).toBe(0);
    expect(u.combined.totalTokens).toBe(30);
  });

  it("reports a real zero only when the trace proves zero usage", () => {
    const spans = [
      span("root", null, "EVALUATION"),
      span("task", "root", "TASK"),
      span("task-llm", "task", "LLM", {
        input_tokens: 0,
        output_tokens: 0,
        total_tokens: 0,
        cost: 0,
      }),
    ];
    const u = attributeTraceUsage(spans);
    expect(u.state).toBe("present"); // usage fields present (all zero) → a real zero
    expect(u.task.totalTokens).toBe(0);
    expect(u.task.spanCount).toBe(1);
  });
});
