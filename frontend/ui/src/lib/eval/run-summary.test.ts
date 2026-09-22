import { describe, it, expect } from "vitest";
import type { ComparisonScore, ComparisonScorerMeta } from "./comparison";
import { summarizeRun, type SummaryItem, type SummaryResult } from "./run-summary";

// ── builders ─────────────────────────────────────────────────────────────

function score(name: string, opts: Partial<ComparisonScore> = {}): ComparisonScore {
  return {
    scorerName: name,
    scorerVersion: opts.scorerVersion ?? "v1",
    numericValue: opts.numericValue ?? null,
    boolValue: opts.boolValue ?? null,
    stringValue: opts.stringValue ?? null,
    error: opts.error ?? null,
  };
}

function result(opts: Partial<SummaryResult> = {}): SummaryResult {
  return {
    durationMs: opts.durationMs ?? null,
    cost: opts.cost ?? null,
    scores: opts.scores ?? [],
  };
}

const meta = (name: string, opts: Partial<ComparisonScorerMeta> = {}): ComparisonScorerMeta => ({
  name,
  version: "v1",
  ...opts,
});

const byName = (items: SummaryItem[]) => Object.fromEntries(items.map((i) => [i.name, i]));

// ── scores ───────────────────────────────────────────────────────────────

describe("summarizeRun — scores", () => {
  it("averages a numeric scorer over the results that reported it", () => {
    const { scores } = summarizeRun(
      [meta("acc")],
      [
        result({ scores: [score("acc", { numericValue: 1 })] }),
        result({ scores: [score("acc", { numericValue: 0.5 })] }),
        result({ scores: [score("acc", { numericValue: 0 })] }),
      ],
    );
    expect(scores).toEqual([
      {
        name: "acc",
        unit: null,
        direction: "higher_is_better",
        valueType: "numeric",
        value: 0.5,
        observedCount: 3,
      },
    ]);
  });

  it("reads a boolean scorer's mean as its pass rate", () => {
    const { scores } = summarizeRun(
      [meta("exact")],
      [
        result({ scores: [score("exact", { boolValue: true })] }),
        result({ scores: [score("exact", { boolValue: true })] }),
        result({ scores: [score("exact", { boolValue: false })] }),
        result({ scores: [score("exact", { boolValue: true })] }),
      ],
    );
    expect(scores[0]).toMatchObject({ valueType: "boolean", value: 0.75, observedCount: 4 });
  });

  it("leaves errored, empty and missing scores out of the mean instead of counting them as 0", () => {
    const { scores } = summarizeRun(
      [meta("acc")],
      [
        result({ scores: [score("acc", { numericValue: 0.8 })] }),
        result({ scores: [score("acc", { error: "judge timed out" })] }),
        result({ scores: [score("acc")] }), // a row with no value and no error
        result({ scores: [] }), // the scorer never ran on this case
      ],
    );
    expect(scores[0]).toMatchObject({ value: 0.8, observedCount: 1 });
  });

  it("keeps a declared scorer nothing scored, with a null mean", () => {
    // An empty row is information: the scorer was declared and produced nothing.
    const { scores } = summarizeRun(
      [meta("acc")],
      [result({ scores: [score("acc", { error: "boom" })] })],
    );
    expect(scores).toEqual([
      {
        name: "acc",
        unit: null,
        direction: "higher_is_better",
        valueType: "numeric",
        value: null,
        observedCount: 0,
      },
    ]);
  });

  it("never averages a categorical score, but still counts its labels", () => {
    const { scores } = summarizeRun(
      [meta("route", { valueType: "categorical" })],
      [
        result({ scores: [score("route", { stringValue: "billing" })] }),
        result({ scores: [score("route", { stringValue: "refunds" })] }),
      ],
    );
    expect(scores[0]).toEqual({
      name: "route",
      unit: null,
      direction: "none",
      valueType: "categorical",
      value: null,
      observedCount: 2,
    });
  });

  it("does not average a scorer declared categorical even if it stored numbers", () => {
    const { scores } = summarizeRun(
      [meta("grade", { valueType: "categorical" })],
      [result({ scores: [score("grade", { numericValue: 3 })] })],
    );
    expect(scores[0]).toMatchObject({
      valueType: "categorical",
      value: null,
      direction: "none",
      observedCount: 1,
    });
  });

  it("carries a declared direction instead of the default", () => {
    const { scores } = summarizeRun(
      [meta("hallucination", { direction: "lower_is_better" })],
      [result({ scores: [score("hallucination", { numericValue: 0.1 })] })],
    );
    expect(scores[0].direction).toBe("lower_is_better");
  });

  it("counts the row carrying the declared version when a result has two for one scorer", () => {
    // The manifest says which version the run ran with. String order would not: "v10"
    // sorts below "v9", and an llm_judge version is a config hash with no order at all.
    const rows = [
      score("acc", { scorerVersion: "v9", numericValue: 0.2 }),
      score("acc", { scorerVersion: "v10", numericValue: 0.9 }),
    ];
    for (const ordered of [rows, [...rows].reverse()]) {
      const { scores } = summarizeRun(
        [meta("acc", { version: "v10" })],
        [result({ scores: ordered })],
      );
      expect(scores[0]).toMatchObject({ value: 0.9, observedCount: 1 });
    }
  });

  it("falls back to the engine's tie-break when no row carries the declared version", () => {
    const rows = [
      score("acc", { scorerVersion: "v2", numericValue: 1 }),
      score("acc", { scorerVersion: "v1", numericValue: 0 }),
    ];
    for (const ordered of [rows, [...rows].reverse()]) {
      const { scores } = summarizeRun(
        [meta("acc", { version: "v0" })],
        [result({ scores: ordered })],
      );
      expect(scores[0]).toMatchObject({ value: 1, observedCount: 1 });
    }
  });

  it("gives no mean to an undeclared scorer that stored labels and numbers together", () => {
    // The engine calls this type_mismatch: the instrument changed, so no single reading
    // of it is honest. Every observation still counts toward observedCount.
    const { scores } = summarizeRun(
      [],
      [
        result({ scores: [score("grade", { stringValue: "a" })] }),
        result({ scores: [score("grade", { stringValue: "b" })] }),
        result({ scores: [score("grade", { numericValue: 0.2 })] }),
      ],
    );
    expect(scores[0]).toMatchObject({
      valueType: "categorical",
      direction: "none",
      value: null,
      observedCount: 3,
    });
  });

  it("gives no mean to a declared numeric scorer that also stored a label", () => {
    const { scores } = summarizeRun(
      [meta("acc", { valueType: "numeric" })],
      [
        result({ scores: [score("acc", { numericValue: 0.4 })] }),
        result({ scores: [score("acc", { stringValue: "n/a" })] }),
      ],
    );
    expect(scores[0]).toMatchObject({ valueType: "numeric", value: null, observedCount: 2 });
  });

  it("keeps an undeclared scorer that only ever errored, with a null mean", () => {
    const { scores } = summarizeRun(
      [meta("acc")],
      [
        result({
          scores: [score("acc", { numericValue: 1 }), score("judge", { error: "timed out" })],
        }),
      ],
    );
    expect(scores.map((s) => s.name)).toEqual(["acc", "judge"]);
    expect(scores[1]).toMatchObject({ value: null, observedCount: 0 });
  });

  it("drops a non-finite stored value rather than poisoning the mean", () => {
    const { scores } = summarizeRun(
      [meta("acc")],
      [
        result({ scores: [score("acc", { numericValue: Number.NaN })] }),
        result({ scores: [score("acc", { numericValue: 0.4 })] }),
      ],
    );
    expect(scores[0]).toMatchObject({ value: 0.4, observedCount: 1 });
  });

  it("lists declared scorers first, in declared order, then undeclared ones by name", () => {
    const { scores } = summarizeRun(
      [meta("declared_b"), meta("declared_a")],
      [
        result({ scores: [score("extra_z", { numericValue: 1 })] }),
        result({ scores: [score("extra_y", { numericValue: 1 })] }),
        result({ scores: [score("declared_a", { numericValue: 1 })] }),
      ],
    );
    // By name, not first-seen: the results query has no order, so first-seen is not stable.
    expect(scores.map((s) => s.name)).toEqual(["declared_b", "declared_a", "extra_y", "extra_z"]);
  });
});

// ── derived metrics ──────────────────────────────────────────────────────

describe("summarizeRun — derived metrics", () => {
  it("averages each metric over the results that reported it, with its unit", () => {
    const { metrics } = summarizeRun(
      [],
      [result({ durationMs: 100, cost: 0.02 }), result({ durationMs: 300, cost: null })],
    );
    const m = byName(metrics);
    expect(m.duration).toEqual({
      name: "duration",
      unit: "ms",
      direction: "lower_is_better",
      valueType: "numeric",
      value: 200,
      observedCount: 2,
    });
    expect(m.cost).toMatchObject({ unit: "$", value: 0.02, observedCount: 1 });
  });

  it("returns every metric in a stable order, null where nothing reported it", () => {
    const { metrics } = summarizeRun([], [result({ durationMs: 50 })]);
    expect(metrics.map((m) => m.name)).toEqual(["duration", "cost"]);
    expect(byName(metrics).cost).toMatchObject({ value: null, observedCount: 0 });
  });

  it("treats a reported zero as a measurement, not as missing", () => {
    const { metrics } = summarizeRun([], [result({ cost: 0 }), result({ cost: 0.04 })]);
    expect(byName(metrics).cost).toMatchObject({ value: 0.02, observedCount: 2 });
  });

  it("summarizes an empty run as nulls, not zeros", () => {
    const { scores, metrics } = summarizeRun([meta("acc")], []);
    expect(scores[0]).toMatchObject({ value: null, observedCount: 0 });
    for (const m of metrics) expect(m).toMatchObject({ value: null, observedCount: 0 });
  });
});
