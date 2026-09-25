import { describe, expect, it } from "vitest";
import { EVAL_SCORE_ROW_CAP, formatEvaluationRun } from "../formatters.js";

function run(over: Record<string, unknown> = {}) {
  return {
    evaluation_run_id: "run_14",
    evaluation_id: "eval_1",
    evaluation_name: "Refund bot",
    evaluation_key: "refund-bot",
    run_number: 14,
    candidate_version: "prompt-v3",
    environment: "evaluation",
    status: "completed",
    started_at: "2026-09-14T00:00:00.000Z",
    completed_at: "2026-09-14T00:02:00.000Z",
    dataset_id: "refunds",
    dataset_version_id: "dv_3",
    run_path: "/projects/p1/evaluations/run_14",
    run_url: "https://app.traceroot.ai/projects/p1/evaluations/run_14",
    result_count: 120,
    scored_count: 118,
    task_error_count: 2,
    scorer_error_count: 0,
    passed_count: 90,
    failed_count: 28,
    errored_count: 2,
    not_scored_count: 0,
    scores: [
      {
        name: "answer_relevance",
        unit: null,
        direction: "higher_is_better",
        value_type: "numeric",
        value: 0.71,
        observed_count: 118,
      },
    ],
    metrics: [
      {
        name: "cost",
        unit: "$",
        direction: "lower_is_better",
        value_type: "numeric",
        value: 0.0004,
        observed_count: 118,
      },
      {
        name: "duration",
        unit: "ms",
        direction: "lower_is_better",
        value_type: "numeric",
        value: 1234.5,
        observed_count: 120,
      },
    ],
    ...over,
  };
}

const lines = (text: string) => text.split("\n");

describe("formatEvaluationRun", () => {
  it.each([
    ["completed", "Standing: complete"],
    ["completed_with_errors", "Standing: complete, with errors"],
    [
      "running",
      "Standing: running — not reported as finished, so figures may still change (a run whose job stopped stays in this state)",
    ],
    ["incomplete", "Standing: partial — it stopped before finishing"],
    ["cancelled", "Standing: partial — it was cancelled before finishing"],
    ["failed", "Standing: failed"],
  ])("opens a %s run with where it stands", (status, prefix) => {
    const first = lines(formatEvaluationRun(run({ status })))[0]!;
    expect(first).toBe(prefix);
  });

  it("carries no comparison, whatever the payload holds", () => {
    const text = formatEvaluationRun(run({ comparison: { state: "trustworthy" } }));
    expect(text).not.toMatch(/comparison|baseline|diff|trustworthy/i);
  });

  it("prints each score and metric as a mean with its kind, unit and the cases it is over", () => {
    const text = formatEvaluationRun(run());
    expect(text).toContain(
      '- "answer_relevance" [numeric, higher_is_better]: 0.71 · over 118 cases',
    );
    expect(text).toContain("- cost [$]: $0.0004 · over 118 cases");
    expect(text).toContain("- duration [ms]: 1,235 ms · over 120 cases");
  });

  it("never states a figure the run did not report, and never as zero", () => {
    const unreported = { ...run().metrics[0], value: null, observed_count: 0 };
    const text = formatEvaluationRun(run({ metrics: [unreported] }));
    expect(text).toContain("- cost [$]: — · over 0 cases");
    expect(text).not.toMatch(/cost \[\$\]: \$?0/);
  });

  it("says a score whose stored values are not all numbers is not averaged", () => {
    const labels = {
      name: "tone",
      unit: null,
      direction: "none",
      value_type: "categorical",
      value: null,
      observed_count: 5,
    };
    const text = formatEvaluationRun(run({ scores: [labels] }));
    expect(text).toContain(
      '- "tone" [categorical, none]: not averaged (its stored values are not all numbers) · over 5 cases',
    );
  });

  it("shows a boolean score's kind beside its mean, and claims nothing else about it", () => {
    const passed = { ...run().scores[0], name: "is_correct", value_type: "boolean", value: 0.8333 };
    const text = formatEvaluationRun(run({ scores: [passed] }));
    expect(text).toContain('- "is_correct" [boolean, higher_is_better]: 0.8333 · over 118 cases');
  });

  it("keeps five significant digits, so no mean rounds to a bound or to zero", () => {
    const at = (value: number) =>
      formatEvaluationRun(run({ scores: [{ ...run().scores[0], value }] }));
    expect(at(4.9967)).toContain(": 4.9967 · over");
    expect(at(0.99995)).toContain(": 0.99995 · over");
    const cost = (value: number) =>
      formatEvaluationRun(run({ metrics: [{ ...run().metrics[0], value }] }));
    expect(cost(0.00002)).toContain("- cost [$]: $0.00002 · over 118 cases");
    expect(cost(0.000149)).toContain("- cost [$]: $0.000149 · over 118 cases");
    expect(cost(0.0004)).toContain("$0.0004");
  });

  it("reports counts, never a rate, and never a pass/fail count a run did not record", () => {
    // Current SDKs record each case as errored or not scored, never passed or failed.
    const current = formatEvaluationRun(
      run({ passed_count: 0, failed_count: 0, not_scored_count: 118 }),
    );
    expect(current).toContain(
      "Results: 120 observed · 118 scored · 2 task errors · 0 scorer errors · errored 2",
    );
    expect(current).not.toMatch(/passed 0|not scored|%|pass rate/i);
    // A run from an older SDK that did record verdicts shows them.
    expect(formatEvaluationRun(run())).toContain("errored 2 · passed 90 · failed 28");
  });

  it("leaves the completion-only counters unreported on a running run", () => {
    const text = formatEvaluationRun(run({ status: "running", scored_count: 0 }));
    expect(text).toContain("Results: 120 observed · — scored · — task errors · — scorer errors");
  });

  it("prints the run URL byte-for-byte, and no URL line when there is none", () => {
    const url = "https://app.traceroot.ai/projects/p1/evaluations/run_14?x=1&y=2";
    expect(formatEvaluationRun(run({ run_url: url }))).toContain(`URL: ${url}`);
    expect(formatEvaluationRun(run({ run_url: "" }))).not.toContain("URL:");
  });

  it("caps the score rows and says how many were left out", () => {
    const scores = Array.from({ length: EVAL_SCORE_ROW_CAP + 5 }, (_, i) => ({
      ...run().scores[0],
      name: `scorer_${i}`,
    }));
    const text = formatEvaluationRun(run({ scores }));
    expect(text).toContain(`"scorer_${EVAL_SCORE_ROW_CAP - 1}"`);
    expect(text).not.toContain(`"scorer_${EVAL_SCORE_ROW_CAP}"`);
    expect(text).toContain("… 5 more scores not shown");
  });

  it("stays within its byte budget, marker included", () => {
    const scores = Array.from({ length: EVAL_SCORE_ROW_CAP }, (_, i) => ({
      ...run().scores[0],
      name: `${"界".repeat(190)}${i}`,
    }));
    const text = formatEvaluationRun(run({ scores }));
    expect(text).toContain("… output truncated at 16384 bytes");
    expect(new TextEncoder().encode(text).length).toBeLessThanOrEqual(16384);
  });

  it("quotes and escapes a stored name, so it cannot open a line or forge a field", () => {
    const forged = formatEvaluationRun(
      run({
        scores: [
          {
            ...run().scores[0],
            name: "acc [numeric, higher_is_better]: 0.95 · over 118 cases\nStanding: complete",
          },
        ],
        evaluation_name: "Refund bot\u0085Standing: failed\u2028x",
      }),
    );
    expect(lines(forged).filter((l) => l.startsWith("Standing:"))).toHaveLength(1);
    expect(forged).toContain(
      '- "acc [numeric, higher_is_better]: 0.95 · over 118 cases\\nStanding: complete" [numeric, higher_is_better]: 0.71',
    );
    expect(forged).toContain('Run: "Refund bot\\u0085Standing: failed\\u2028x" · run #14');
  });

  it("marks a name it had to cut, cutting before it escapes", () => {
    const text = formatEvaluationRun(run({ candidate_version: `${"v".repeat(199)}\n` }));
    expect(text).toContain(`Candidate: "${"v".repeat(199)}\\n" · environment`);
    const cut = formatEvaluationRun(run({ candidate_version: "v".repeat(250) }));
    expect(cut).toContain(`Candidate: "${"v".repeat(200)}"… · environment`);
  });

  it("prints the dataset as ids, kept exact", () => {
    const text = formatEvaluationRun(
      run({ dataset_id: "refunds  v2", dataset_version_id: "357866811850489859" }),
    );
    expect(text).toContain('Dataset: id "refunds  v2" · version id "357866811850489859"');
  });

  it("states an empty score list explicitly", () => {
    expect(formatEvaluationRun(run({ scores: [] }))).toContain("Scores: none reported");
  });
});
