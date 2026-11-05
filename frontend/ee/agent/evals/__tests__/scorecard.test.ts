import { describe, expect, it } from "vitest";
import { allPassed, formatScorecard } from "../scorecard.js";
import type { ScenarioResult } from "../types.js";

const result = (overrides: Partial<ScenarioResult> = {}): ScenarioResult => ({
  name: "standard-detector",
  passed: true,
  durationMs: 1200,
  turns: [],
  ...overrides,
});

describe("formatScorecard", () => {
  it("lists every scenario with its outcome", () => {
    const table = formatScorecard([
      result({ name: "standard-detector" }),
      result({ name: "sparkline", passed: false, error: "no disclosure" }),
    ]);

    expect(table).toMatch(/standard-detector/);
    expect(table).toMatch(/sparkline/);
    expect(table).toMatch(/PASS/);
    expect(table).toMatch(/FAIL/);
  });

  it("shows the failed assertion next to the failing scenario", () => {
    expect(formatScorecard([result({ passed: false, error: "no disclosure" })])).toMatch(
      /no disclosure/,
    );
  });

  it("summarises the pass count", () => {
    const table = formatScorecard([result(), result({ name: "b", passed: false })]);
    expect(table).toMatch(/1\/2/);
  });

  it("renders an empty run without throwing", () => {
    expect(formatScorecard([])).toMatch(/0\/0/);
  });

  it("truncates a very long failure message so the table stays readable", () => {
    const table = formatScorecard([result({ passed: false, error: "x".repeat(400) })]);
    expect(table).toMatch(/…/);
    expect(table.length).toBeLessThan(600);
  });
});

describe("allPassed", () => {
  it("is true when every scenario passed", () => {
    expect(allPassed([result(), result({ name: "b" })])).toBe(true);
  });

  it("is false when any scenario failed", () => {
    expect(allPassed([result(), result({ name: "b", passed: false })])).toBe(false);
  });

  it("is false for an empty run, which means nothing was proven", () => {
    expect(allPassed([])).toBe(false);
  });
});
