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

  it("does not call one more failure in a small window a rise", () => {
    const small = (failures: number) =>
      aggregates({
        totals: {
          traces: 30,
          errorTraces: failures,
          p50Ms: 1000,
          p95Ms: 2500,
          p99Ms: 3000,
          gitContextTraces: 0,
        },
      });
    expect(
      find(computeUpdateFacts(small(1), small(0)), "project:all traffic:error_rate"),
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
    const now = aggregates({ workflows: [wf(200, 6, 1900), control] });
    const before = aggregates({ workflows: [wf(400, 12, 1000), control] });
    const facts = computeUpdateFacts(now, before);
    expect(find(facts, "workflow:a:trace_volume")).toMatchObject({
      direction: "down",
      relativeChange: -0.5,
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

  it("keeps percentages out of the overview when the base or sample is small", () => {
    const tiny = (traces: number, failures: number) =>
      aggregates({
        totals: {
          traces,
          errorTraces: failures,
          p50Ms: 800,
          p95Ms: 900,
          p99Ms: 900,
          gitContextTraces: 0,
        },
        llm: {
          calls: traces,
          inputTokens: 0,
          outputTokens: 0,
          totalTokens: traces * 100,
          cost: String(traces * 0.001),
        },
      });
    const { overview } = computeUpdateFacts(tiny(10, 2), tiny(6, 0));
    for (const metric of Object.values(overview)) expect(metric.relativeChange).toBeNull();
    expect(overview.traces).toMatchObject({ current: 10, previous: 6, absoluteChange: 4 });
    const big = computeUpdateFacts(
      aggregates({ totals: { ...aggregates().totals, traces: 1500 } }),
      aggregates(),
    );
    expect(big.overview.traces.relativeChange).toBe(0.5);
  });

  it("shows no overview percentage for a movement that is not a finding", () => {
    const base = aggregates();
    const now = aggregates({
      totals: { ...base.totals, errorTraces: 36, p50Ms: 1100 },
      llm: { ...base.llm, cost: "10.6" },
    });
    const facts = computeUpdateFacts(now, base);
    expect(facts.findings).toEqual([]);
    expect(facts.overview.errorRate.relativeChange).toBeNull();
    expect(facts.overview.latencyP50Ms.relativeChange).toBeNull();
    expect(facts.overview.llmCostUsd.relativeChange).toBeNull();
    expect(facts.overview.errorRate.absoluteChange).toBeCloseTo(0.006);
  });

  it("needs enough calls behind a cost percentage, not just a big enough number", () => {
    const model = (calls: number, cost: string) => [
      { model: "m1", calls, totalTokens: calls * 100_000, cost },
    ];
    const facts = computeUpdateFacts(
      aggregates({
        byModel: model(3, "1.20"),
        llm: { ...aggregates().llm, calls: 3, cost: "1.20" },
      }),
      aggregates({
        byModel: model(1, "0.40"),
        llm: { ...aggregates().llm, calls: 1, cost: "0.40" },
      }),
    );
    expect(find(facts, "model:m1:cost")).toMatchObject({
      kind: "absolute_only",
      relativeChange: null,
    });
    expect(find(facts, "project:all models:cost")).toMatchObject({ kind: "absolute_only" });
    expect(facts.overview.llmCostUsd.relativeChange).toBeNull();
  });

  it("does not call a tool seen once or twice new", () => {
    const now = aggregates({
      tools: [
        { name: "search", calls: 500, errors: 10 },
        { name: "blip", calls: 2, errors: 0 },
      ],
    });
    expect(find(computeUpdateFacts(now, aggregates()), "tool:blip:presence")).toBeUndefined();
  });

  it("lists the top models by spend with shares worked out in code", () => {
    const models = [
      { model: "a", calls: 1, totalTokens: 10, cost: "6.0" },
      { model: "b", calls: 1, totalTokens: 10, cost: "3.0" },
      { model: "c", calls: 1, totalTokens: 10, cost: "1.0" },
    ];
    const facts = computeUpdateFacts(
      aggregates({ byModel: models, llm: { ...aggregates().llm, cost: "10.0" } }),
      aggregates({ byModel: [{ model: "a", calls: 1, totalTokens: 10, cost: "5.0" }] }),
    );
    expect(facts.topModels.map((m) => [m.model, m.shareOfCost])).toEqual([
      ["a", 0.6],
      ["b", 0.3],
      ["c", 0.1],
    ]);
    expect(facts.topModels[0].previousCostUsd).toBe(5);
  });

  it("rarely calls an unchanged error rate a change, at any volume", () => {
    // A seeded stream of binomial draws around a fixed 5% rate.
    let state = 12345;
    const next = () => (state = (state * 1103515245 + 12345) % 2147483648) / 2147483648;
    const draw = (n: number) => Array.from({ length: n }, next).filter((x) => x < 0.05).length;
    for (const n of [40, 100, 300]) {
      let flagged = 0;
      const trials = 400;
      for (let i = 0; i < trials; i += 1) {
        const side = (failures: number) =>
          aggregates({
            totals: {
              traces: n,
              errorTraces: failures,
              p50Ms: 1000,
              p95Ms: 2500,
              p99Ms: 3000,
              gitContextTraces: 0,
            },
          });
        const facts = computeUpdateFacts(side(draw(n)), side(draw(n)));
        if (facts.findings.some((f) => f.id === "project:all traffic:error_rate")) flagged += 1;
      }
      expect(flagged / trials).toBeLessThan(0.05);
    }
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
    const strict = {
      ...DEFAULT_NOISE_RULES,
      errorRate: { minAbs: 0.005, minRel: 0.1, minFailures: 1, minZ: 1 },
    };
    expect(
      find(computeUpdateFacts(now, aggregates(), strict), "project:all traffic:error_rate"),
    ).toBeDefined();
  });
});
