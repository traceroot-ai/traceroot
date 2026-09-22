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
    ["running", "Standing: still running — every figure below will change"],
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

  it("prints each score and metric as a mean with its unit and the cases it is over", () => {
    const text = formatEvaluationRun(run());
    expect(text).toContain("- answer_relevance [higher_is_better]: 0.71 · over 118 cases");
    expect(text).toContain("- cost [$]: $0.0004 · over 118 cases");
    expect(text).toContain("- duration [ms]: 1,235 ms · over 120 cases");
  });

  it("never states a figure the run did not report, and never as zero", () => {
    const unreported = { ...run().metrics[0], value: null, observed_count: 0 };
    const text = formatEvaluationRun(run({ metrics: [unreported] }));
    expect(text).toContain("- cost [$]: — · over 0 cases");
    expect(text).not.toMatch(/cost \[\$\]: \$?0/);
  });

  it("says a categorical or mixed score is not averaged, rather than unreported", () => {
    const labels = {
      name: "tone",
      unit: null,
      direction: "none",
      value_type: "categorical",
      value: null,
      observed_count: 5,
    };
    const mixed = {
      ...labels,
      name: "grade",
      direction: "higher_is_better",
      value_type: "numeric",
    };
    const text = formatEvaluationRun(run({ scores: [labels, mixed] }));
    expect(text).toContain("- tone [none]: not averaged (labels, not numbers) · over 5 cases");
    expect(text).toContain(
      "- grade [higher_is_better]: not averaged (labels and numbers mixed) · over 5 cases",
    );
  });

  it("labels a boolean score's mean as the share of cases that were true", () => {
    const passed = {
      name: "is_correct",
      unit: null,
      direction: "higher_is_better",
      value_type: "boolean",
      value: 0.8333,
      observed_count: 6,
    };
    const text = formatEvaluationRun(run({ scores: [passed] }));
    expect(text).toContain(
      "- is_correct [higher_is_better]: 0.8333 (share of cases true) · over 6 cases",
    );
  });

  it("keeps a small per-case cost at four decimals", () => {
    expect(formatEvaluationRun(run())).toContain("$0.0004");
  });

  it("never rounds a tiny measured value to zero", () => {
    const tiny = { ...run().metrics[0], value: 0.00002 };
    const text = formatEvaluationRun(run({ metrics: [tiny] }));
    expect(text).toContain("- cost [$]: $0.00002 · over 118 cases");
    expect(text).not.toMatch(/\$0(?![.\d])/);
  });

  it("reports counts and never a rate or a percentage", () => {
    const text = formatEvaluationRun(run());
    expect(text).toContain(
      "Results: 120 observed · 118 scored · 2 task errors · 0 scorer errors · passed 90 · failed 28 · errored 2 · not scored 0",
    );
    expect(text).not.toMatch(/%|pass rate/i);
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
    expect(text).toContain(`scorer_${EVAL_SCORE_ROW_CAP - 1}`);
    expect(text).not.toContain(`scorer_${EVAL_SCORE_ROW_CAP} `);
    expect(text).toContain("… 5 more scores not shown");
  });

  it("keeps an authored name on one line so it cannot forge a line", () => {
    const text = formatEvaluationRun(
      run({ scores: [{ ...run().scores[0], name: "acc\nStanding: complete" }] }),
    );
    expect(text).toContain("- acc Standing: complete [higher_is_better]");
    expect(lines(text).filter((l) => l.startsWith("Standing:"))).toHaveLength(1);
  });

  it("marks a name it had to cut, so it is never quoted as complete", () => {
    const text = formatEvaluationRun(run({ candidate_version: "v".repeat(150) }));
    expect(text).toContain(`Candidate: ${"v".repeat(100)}… · environment`);
  });

  it("keeps an SDK-chosen dataset id on one line too", () => {
    const text = formatEvaluationRun(run({ dataset_id: "refunds\nStanding: complete" }));
    expect(text).toContain("Dataset: refunds Standing: complete @ version dv_3");
    expect(lines(text).filter((l) => l.startsWith("Standing:"))).toHaveLength(1);
  });

  it("states an empty score list explicitly", () => {
    expect(formatEvaluationRun(run({ scores: [] }))).toContain("Scores: none reported");
  });
});
