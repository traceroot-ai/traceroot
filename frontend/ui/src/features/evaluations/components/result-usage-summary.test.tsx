// @vitest-environment jsdom
/**
 * Single-result usage split (F1) + observed judge model (F2). Drives the panel through
 * every state the spec calls out: both observed, judge unknown, multi-model judge,
 * pending ingestion, cost-unknown vs genuine-zero, and no misleading combined total.
 */
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { attributeTraceUsage, type UsageSpan } from "@/lib/eval/trace-usage";
import { ResultUsageSummary } from "./result-usage-summary";

afterEach(() => cleanup());

function span(id: string, parent: string | null, kind: string, u: Partial<UsageSpan> = {}): UsageSpan {
  return {
    span_id: id,
    parent_span_id: parent,
    span_kind: kind,
    input_tokens: u.input_tokens ?? null,
    output_tokens: u.output_tokens ?? null,
    total_tokens: u.total_tokens ?? null,
    cost: u.cost ?? null,
    model_name: u.model_name ?? null,
  };
}

function rowText(label: string): string {
  return screen.getByText(label).parentElement?.textContent ?? "";
}

function renderUsage(spans: UsageSpan[] | null, opts: { durationMs?: number | null; taskCost?: number | null } = {}) {
  render(
    <ResultUsageSummary
      usage={attributeTraceUsage(spans)}
      durationMs={"durationMs" in opts ? (opts.durationMs ?? null) : 1800}
      taskCost={"taskCost" in opts ? (opts.taskCost ?? null) : 0.003}
    />,
  );
}

describe("ResultUsageSummary", () => {
  it("splits candidate execution from evaluation overhead when both are observed", () => {
    renderUsage([
      span("r", null, "EVALUATION"),
      span("t", "r", "TASK"),
      span("tl", "t", "LLM", { input_tokens: 100, output_tokens: 20, total_tokens: 120, cost: 0.003, model_name: "claude-sonnet-4" }),
      span("s", "r", "SCORER"),
      span("jl", "s", "LLM", { total_tokens: 45, cost: 0.001, model_name: "gpt-4o" }),
    ]);

    expect(screen.getByText("Candidate execution")).toBeDefined();
    expect(rowText("Observed task model")).toContain("claude-sonnet-4");
    expect(rowText("Tokens")).toMatch(/120 total/);
    expect(rowText("Task cost")).toContain("$0.0030");

    expect(screen.getByText("Evaluation overhead")).toBeDefined();
    expect(rowText("Judge model")).toContain("gpt-4o");
    expect(rowText("Judge tokens")).toContain("45");
    expect(rowText("Judge cost")).toContain("$0.0010");

    // The ONLY combined figure, and it is explicitly labelled — 120 + 45 = 165.
    expect(screen.getByText(/Total including evaluation/)).toBeDefined();
    expect(screen.getByText(/Total including evaluation/).parentElement?.textContent).toMatch(/165/);
  });

  it("never folds judge cost into the candidate's task cost", () => {
    renderUsage(
      [
        span("r", null, "EVALUATION"),
        span("t", "r", "TASK"),
        span("tl", "t", "LLM", { total_tokens: 100, cost: 0.005, model_name: "m" }),
        span("s", "r", "SCORER"),
        span("jl", "s", "LLM", { total_tokens: 30, cost: 0.009, model_name: "judge" }),
      ],
      { taskCost: 0.005 },
    );
    // Candidate task cost is exactly the task cost (0.005), NOT task+judge (0.014).
    expect(rowText("Task cost")).toContain("$0.0050");
    expect(rowText("Judge cost")).toContain("$0.0090");
  });

  it("says there was no evaluator LLM call when the judge is a non-LLM scorer", () => {
    renderUsage([
      span("r", null, "EVALUATION"),
      span("t", "r", "TASK"),
      span("tl", "t", "LLM", { total_tokens: 100, cost: 0.003, model_name: "claude-sonnet-4" }),
      span("s", "r", "SCORER"), // a code/heuristic scorer — no LLM leaf under it
    ]);
    expect(rowText("Observed task model")).toContain("claude-sonnet-4");
    expect(screen.getByText("No evaluator LLM calls")).toBeDefined();
    // No misleading combined total when there is no evaluation overhead.
    expect(screen.queryByText(/Total including evaluation/)).toBeNull();
  });

  it("lists every judge model when the judge makes multiple model calls", () => {
    renderUsage([
      span("r", null, "EVALUATION"),
      span("t", "r", "TASK"),
      span("tl", "t", "LLM", { total_tokens: 100, cost: 0.003, model_name: "claude-sonnet-4" }),
      span("s", "r", "SCORER"),
      span("j1", "s", "LLM", { total_tokens: 20, cost: 0.001, model_name: "gpt-4o" }),
      span("j2", "s", "LLM", { total_tokens: 25, cost: 0.001, model_name: "gpt-4o-mini" }),
    ]);
    expect(rowText("Judge model")).toContain("gpt-4o");
    expect(rowText("Judge model")).toContain("gpt-4o-mini");
  });

  it("stays pending when the trace has not been ingested yet", () => {
    renderUsage(null);
    // Tokens/overhead are pending, not zero.
    expect(rowText("Tokens")).toContain("Pending");
    // The overhead block shows a single Pending line.
    const overhead = screen.getByText("Evaluation overhead").parentElement;
    expect(overhead?.textContent).toContain("Pending");
  });

  it("distinguishes an unattributed judge cost (Unknown) from a genuine zero", () => {
    // Judge ran (tokens present) but ingest has not attached a cost → Unknown, not $0.
    renderUsage([
      span("r", null, "EVALUATION"),
      span("t", "r", "TASK"),
      span("tl", "t", "LLM", { total_tokens: 100, cost: 0.003, model_name: "m" }),
      span("s", "r", "SCORER"),
      span("jl", "s", "LLM", { total_tokens: 30, cost: null, model_name: "judge" }),
    ]);
    expect(rowText("Judge cost")).toContain("Unknown");

    cleanup();

    // A judge that genuinely cost zero (cost reported as 0) reads as $0, not Unknown.
    renderUsage([
      span("r", null, "EVALUATION"),
      span("t", "r", "TASK"),
      span("tl", "t", "LLM", { total_tokens: 100, cost: 0.003, model_name: "m" }),
      span("s", "r", "SCORER"),
      span("jl", "s", "LLM", { total_tokens: 30, cost: 0, model_name: "judge" }),
    ]);
    expect(rowText("Judge cost")).toMatch(/\$0\.0000/);
  });

  it("shows Unknown for a candidate task cost the read model does not have", () => {
    renderUsage(
      [
        span("r", null, "EVALUATION"),
        span("t", "r", "TASK"),
        span("tl", "t", "LLM", { total_tokens: 100, cost: 0.003, model_name: "m" }),
      ],
      { taskCost: null },
    );
    expect(rowText("Task cost")).toContain("Unknown");
  });
});
