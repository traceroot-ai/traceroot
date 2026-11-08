import { describe, expect, it } from "vitest";
import { computeUpdateFacts, DEFAULT_NOISE_RULES } from "../facts.ts";
import type { WindowAggregates } from "../aggregates.ts";

function aggregates(overrides: Partial<WindowAggregates> = {}): WindowAggregates {
  return {
    start: "2026-10-26T09:00:00Z",
    end: "2026-11-02T09:00:00Z",
    totals: {
      traces: 1000,
      errorTraces: 30,
      p50Ms: 1000,
      p95Ms: 2500,
      p99Ms: 3000,
      gitContextTraces: 0,
    },
    llm: {
      calls: 1000,
      inputTokens: 800_000,
      outputTokens: 200_000,
      totalTokens: 1_000_000,
      cost: "10.0",
    },
    byModel: [{ model: "m1", calls: 1000, totalTokens: 1_000_000, cost: "10.0" }],
    byModelDay: [],
    tools: [{ name: "search", calls: 500, errors: 10 }],
    workflows: [{ name: "wf", traces: 1000, errorTraces: 30, p50Ms: 1000, p95Ms: 2500 }],
    refs: [],
    truncated: [],
    ...overrides,
  };
}

const find = (facts: ReturnType<typeof computeUpdateFacts>, id: string) =>
  facts.findings.find((f) => f.id === id);

describe("computeUpdateFacts", () => {
  it("reports nothing for two identical windows", () => {
    const facts = computeUpdateFacts(aggregates(), aggregates());
    expect(facts.findings).toEqual([]);
    expect(facts.nothingNotable).toBe(true);
    expect(facts.nothingNotableReason).toBe("no_significant_change");
  });

  it("calls two empty windows no traffic", () => {
    const empty = aggregates({
      totals: { traces: 0, errorTraces: 0, p50Ms: 0, p95Ms: 0, p99Ms: 0, gitContextTraces: 0 },
      llm: { calls: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, cost: "0" },
      byModel: [],
      tools: [],
      workflows: [],
    });
    const facts = computeUpdateFacts(empty, empty);
    expect(facts.nothingNotable).toBe(true);
    expect(facts.nothingNotableReason).toBe("no_traffic");
  });

  it("reports an error-rate rise with direction, size and samples", () => {
    const now = aggregates({
      totals: {
        traces: 1000,
        errorTraces: 120,
        p50Ms: 1000,
        p95Ms: 2500,
        p99Ms: 3000,
        gitContextTraces: 0,
      },
    });
    const facts = computeUpdateFacts(now, aggregates());
    const finding = find(facts, "project:all traffic:error_rate")!;
    expect(finding).toMatchObject({
      kind: "change",
      direction: "up",
      before: 0.03,
      after: 0.12,
      relativeChange: 3,
      samples: [1000, 1000],
    });
  });

  it("does not report a movement below the minimum absolute change", () => {
    const now = aggregates({
      totals: {
        traces: 1000,
        errorTraces: 40,
        p50Ms: 1000,
        p95Ms: 2500,
        p99Ms: 3000,
        gitContextTraces: 0,
      },
    });
    // 3.0% to 4.0% is a 33% relative rise but only one percentage point.
    expect(
      find(computeUpdateFacts(now, aggregates()), "project:all traffic:error_rate"),
    ).toBeUndefined();
  });

  it("does not report a movement below the minimum relative change", () => {
    const now = aggregates({
      llm: { calls: 1000, inputTokens: 0, outputTokens: 0, totalTokens: 1_000_000, cost: "10.6" },
      byModel: [{ model: "m1", calls: 1000, totalTokens: 1_000_000, cost: "10.6" }],
    });
    const facts = computeUpdateFacts(now, aggregates());
    expect(find(facts, "project:all models:cost")).toBeUndefined();
    expect(find(facts, "model:m1:cost")).toBeUndefined();
  });

  it("shows only absolute numbers when a sample is too small, never a percentage", () => {
    const small = (failures: number, total: number) =>
      aggregates({
        totals: {
          traces: total,
          errorTraces: failures,
          p50Ms: 800,
          p95Ms: 900,
          p99Ms: 900,
          gitContextTraces: 0,
        },
        workflows: [{ name: "wf", traces: total, errorTraces: failures, p50Ms: 800, p95Ms: 900 }],
      });
    const facts = computeUpdateFacts(small(2, 10), small(0, 6));
    const finding = find(facts, "project:all traffic:error_rate")!;
    expect(finding.kind).toBe("absolute_only");
    expect(finding.relativeChange).toBeNull();
    expect(finding.note).toContain("2 of 10");
    expect(facts.findings.some((f) => f.metric === "latency_p50")).toBe(false);
  });

  it("reports an item present in one window only as a categorical finding", () => {
    const now = aggregates({
      tools: [
        { name: "search", calls: 500, errors: 10 },
        { name: "fresh", calls: 40, errors: 0 },
      ],
      byModel: [
        { model: "m1", calls: 1000, totalTokens: 1_000_000, cost: "10.0" },
        { model: "m2", calls: 5, totalTokens: 1000, cost: "0.01" },
      ],
    });
    const before = aggregates({
      tools: [
        { name: "search", calls: 500, errors: 10 },
        { name: "old", calls: 60, errors: 1 },
      ],
    });
    const facts = computeUpdateFacts(now, before);
    expect(find(facts, "tool:fresh:presence")).toMatchObject({
      kind: "new",
      relativeChange: null,
      after: 40,
    });
    expect(find(facts, "tool:old:presence")).toMatchObject({ kind: "vanished", before: 60 });
    expect(find(facts, "model:m2:presence")).toMatchObject({ kind: "new" });
  });

  it("compares per workflow and leaves an unchanged workflow out", () => {
    const wf = (traces: number, errors: number, p50: number) => ({
      name: "a",
      traces,
      errorTraces: errors,
      p50Ms: p50,
      p95Ms: p50 * 2,
    });
    const control = { name: "control", traces: 400, errorTraces: 12, p50Ms: 900, p95Ms: 1800 };
    const now = aggregates({ workflows: [wf(100, 3, 1900), control] });
    const before = aggregates({ workflows: [wf(300, 9, 1000), control] });
    const facts = computeUpdateFacts(now, before);
    expect(find(facts, "workflow:a:trace_volume")).toMatchObject({
      direction: "down",
      relativeChange: -0.666667,
    });
    expect(find(facts, "workflow:a:latency_p50")).toMatchObject({
      direction: "up",
      before: 1000,
      after: 1900,
    });
    expect(facts.findings.filter((f) => f.entity === "control")).toEqual([]);
  });

  it("shows a jump from a tiny base as numbers only, never a percentage", () => {
    const now = aggregates({
      totals: {
        traces: 25,
        errorTraces: 0,
        p50Ms: 1000,
        p95Ms: 2500,
        p99Ms: 3000,
        gitContextTraces: 0,
      },
      llm: { calls: 25, inputTokens: 0, outputTokens: 0, totalTokens: 1_000_000, cost: "0.30" },
      byModel: [],
    });
    const before = aggregates({
      totals: {
        traces: 1,
        errorTraces: 0,
        p50Ms: 1000,
        p95Ms: 2500,
        p99Ms: 3000,
        gitContextTraces: 0,
      },
      llm: { calls: 1, inputTokens: 0, outputTokens: 0, totalTokens: 1_000, cost: "0.01" },
      byModel: [],
    });
    const facts = computeUpdateFacts(now, before);
    for (const id of [
      "project:all traffic:trace_volume",
      "project:all models:cost",
      "project:all models:tokens",
    ]) {
      expect(find(facts, id)).toMatchObject({ kind: "absolute_only", relativeChange: null });
    }
  });

  it("does not call an item new or vanished when its list was cut at the cap", () => {
    const now = aggregates({
      truncated: ["tools"],
      tools: [{ name: "beyond-the-cap", calls: 40, errors: 0 }],
    });
    const facts = computeUpdateFacts(now, aggregates());
    expect(facts.findings.filter((f) => f.scope === "tool" && f.metric === "presence")).toEqual([]);
  });

  it("is deterministic: same input, same ordered output", () => {
    const now = aggregates({
      totals: {
        traces: 1000,
        errorTraces: 120,
        p50Ms: 2000,
        p95Ms: 5000,
        p99Ms: 6000,
        gitContextTraces: 10,
      },
    });
    const a = computeUpdateFacts(now, aggregates());
    const b = computeUpdateFacts(now, aggregates());
    expect(a).toEqual(b);
    expect(a.findings.map((f) => f.id)).toEqual([...a.findings.map((f) => f.id)].sort());
    expect(a.hasGitContext).toBe(true);
  });

  it("takes its thresholds as a parameter", () => {
    const now = aggregates({
      totals: {
        traces: 1000,
        errorTraces: 40,
        p50Ms: 1000,
        p95Ms: 2500,
        p99Ms: 3000,
        gitContextTraces: 0,
      },
    });
    const strict = { ...DEFAULT_NOISE_RULES, errorRate: { minAbs: 0.005, minRel: 0.1 } };
    expect(
      find(computeUpdateFacts(now, aggregates(), strict), "project:all traffic:error_rate"),
    ).toBeDefined();
  });
});
