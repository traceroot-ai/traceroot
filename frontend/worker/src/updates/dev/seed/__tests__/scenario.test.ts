import { describe, expect, it } from "vitest";
import { Rng, exactQuantile, hexId, normalQuantile } from "../prng.js";
import { buildScenario, contentDigest, defaultParams } from "../scenario.js";
import { buildManifest } from "../manifest.js";

const SHAS = { base: "a".repeat(40), bad: "b".repeat(40), ctl: "c".repeat(40) };
const scenarioFor = (overrides = {}) => buildScenario(defaultParams(overrides), SHAS);
const project = (s: ReturnType<typeof scenarioFor>, key: string) =>
  s.projects.find((p) => p.key === key)!;

describe("prng", () => {
  it("repeats for the same seed and differs for another", () => {
    const a = Array.from(
      { length: 5 },
      (
        (r) => () =>
          r.next()
      )(new Rng("x")),
    );
    const b = Array.from(
      { length: 5 },
      (
        (r) => () =>
          r.next()
      )(new Rng("x")),
    );
    const c = Array.from(
      { length: 5 },
      (
        (r) => () =>
          r.next()
      )(new Rng("y")),
    );
    expect(a).toEqual(b);
    expect(a).not.toEqual(c);
  });

  it("inverts the normal curve", () => {
    expect(normalQuantile(0.5)).toBeCloseTo(0, 6);
    expect(normalQuantile(0.975)).toBeCloseTo(1.959964, 4);
    expect(normalQuantile(0.01)).toBeCloseTo(-2.326348, 4);
  });

  it("picks the element ClickHouse's exact quantile picks", () => {
    expect(exactQuantile([10, 20, 30, 40], 0.5)).toBe(30);
    expect(exactQuantile([10, 20, 30, 40], 0.95)).toBe(40);
    expect(exactQuantile([], 0.5)).toBe(0);
  });

  it("derives stable ids", () => {
    expect(hexId("k", 16)).toBe(hexId("k", 16));
    expect(hexId("k", 16)).toHaveLength(16);
  });
});

describe("determinism (S1)", () => {
  it("gives the same rows and manifest for the same seed", () => {
    const a = scenarioFor();
    const b = scenarioFor();
    expect(contentDigest(a)).toBe(contentDigest(b));
    const repos = {} as never;
    expect(buildManifest(a, repos)).toEqual(buildManifest(b, repos));
  });

  it("changes with the seed", () => {
    expect(contentDigest(scenarioFor())).not.toBe(contentDigest(scenarioFor({ seed: "other" })));
  });
});

describe("planted ground truth (S2)", () => {
  const s = scenarioFor();
  const main = project(s, "main");
  const cur = main.metrics.cur;
  const prev = main.metrics.prev;

  it("puts every trace and span inside its window", () => {
    const start = s.windows.prevWindowStart.getTime();
    const end = s.windows.windowEnd.getTime();
    for (const p of s.projects) {
      for (const t of p.data.traces) {
        const ms = Date.parse(t.trace_start_time.replace(" ", "T") + "Z");
        expect(ms).toBeGreaterThanOrEqual(start);
        expect(ms).toBeLessThan(end);
      }
    }
  });

  it("drops checkout_agent volume by more than half", () => {
    expect(
      cur.byWorkflow.checkout_agent.traces / prev.byWorkflow.checkout_agent.traces,
    ).toBeLessThan(0.5);
  });

  it("raises the research_agent error rate roughly fivefold", () => {
    const ratio =
      cur.byWorkflow.research_agent.errorRate / prev.byWorkflow.research_agent.errorRate;
    expect(ratio).toBeGreaterThan(3.5);
    expect(ratio).toBeLessThan(6.5);
  });

  it("spikes gpt-4o cost about threefold and more, with unchanged calls", () => {
    expect(cur.byModel["gpt-4o"].calls).toBe(prev.byModel["gpt-4o"].calls);
    const ratio = Number(cur.byModel["gpt-4o"].cost) / Number(prev.byModel["gpt-4o"].cost);
    expect(ratio).toBeGreaterThan(3);
  });

  it("nearly doubles the triage_agent median latency", () => {
    const ratio = cur.byWorkflow.triage_agent.p50Ms / prev.byWorkflow.triage_agent.p50Ms;
    expect(ratio).toBeGreaterThan(1.7);
    expect(ratio).toBeLessThan(2.1);
  });

  it("introduces refund_lookup and retires legacy_search", () => {
    expect(prev.byTool.refund_lookup).toBeUndefined();
    expect(cur.byTool.refund_lookup.calls).toBeGreaterThan(20);
    expect(cur.byTool.legacy_search).toBeUndefined();
    expect(prev.byTool.legacy_search.calls).toBeGreaterThan(20);
  });

  it("leaves the controls alone", () => {
    expect(cur.byWorkflow.support_agent.traces).toBe(prev.byWorkflow.support_agent.traces);
    expect(cur.byWorkflow.support_agent.errorTraces).toBe(
      prev.byWorkflow.support_agent.errorTraces,
    );
    const p50 = cur.byWorkflow.support_agent.p50Ms / prev.byWorkflow.support_agent.p50Ms;
    expect(Math.abs(p50 - 1)).toBeLessThan(0.08);
    for (const name of ["gpt-4o-mini", "claude-haiku-4-5"]) {
      const ratio = Number(cur.byModel[name].cost) / Number(prev.byModel[name].cost);
      expect(Math.abs(ratio - 1)).toBeLessThan(0.05);
    }
    const docs = cur.byTool.search_docs.calls / prev.byTool.search_docs.calls;
    expect(Math.abs(docs - 1)).toBeLessThan(0.1);
  });

  it("shows the bad ref failing more and the control ref not", () => {
    const refs = cur.byRef;
    expect(refs[SHAS.bad].errorRate).toBeGreaterThan(0.15);
    expect(refs[SHAS.ctl].errorRate).toBeLessThan(0.06);
    expect(refs[SHAS.base].errorRate).toBeLessThan(0.06);
    expect(Object.keys(prev.byRef)).toEqual([SHAS.base]);
  });

  it("describes the same changes in the manifest", () => {
    const kinds = s.changes.map((c) => c.kind).sort();
    expect(kinds).toEqual([
      "cost_spike",
      "error_rate_rise",
      "error_rate_rise",
      "error_rate_rise",
      "error_rate_rise",
      "error_rate_rise",
      "latency_shift",
      "new_tool",
      "vanished_tool",
      "volume_drop",
    ]);
    expect(s.controls.length).toBeGreaterThanOrEqual(5);
  });

  it("plants the injection strings only where intended", () => {
    const traces = main.data.traces.filter((t) => t.input?.includes("PWNED-INJECTION-7731"));
    expect(traces.length).toBe(12);
    expect(traces.every((t) => t.name === "research_agent")).toBe(true);
  });
});

describe("other seeded projects", () => {
  const s = scenarioFor();

  it("has a tiny sample whose error rise is below any sensible minimum", () => {
    const tiny = project(s, "tiny").metrics;
    expect(tiny.prev.traces).toBe(6);
    expect(tiny.cur.traces).toBe(10);
    expect(tiny.prev.errorTraces).toBe(0);
    expect(tiny.cur.errorTraces).toBe(2);
  });

  it("has an empty project with no rows at all", () => {
    const empty = project(s, "empty");
    expect(empty.data.traces).toHaveLength(0);
    expect(empty.metrics.cur.traces).toBe(0);
  });

  it("has no git context in the no-git project", () => {
    const nogit = project(s, "nogit");
    expect(nogit.data.traces.every((t) => t.git_ref === null && t.git_repo === null)).toBe(true);
  });

  it("keeps the other tenant's markers out of every other project", () => {
    const text = (key: string) =>
      JSON.stringify([
        project(s, key).data.traces,
        project(s, key).data.spans,
        project(s, key).signals,
      ]);
    for (const key of ["main", "nogit", "tiny", "empty"]) {
      for (const marker of ["tenantb", "TENANTB"]) expect(text(key)).not.toContain(marker);
    }
    expect(text("other")).toContain("tenantb_marker_agent");
  });

  it("scales volume", () => {
    const small = scenarioFor({ volume: 0.25 });
    expect(project(small, "main").data.traces.length).toBeLessThan(
      project(s, "main").data.traces.length / 3,
    );
  });

  it("follows the schedule for a daily cadence and a timezone", () => {
    const daily = scenarioFor({ frequency: "daily", timezone: "America/New_York", hour: 8 });
    expect(daily.windows.windowEnd.toISOString()).toBe("2026-11-01T13:00:00.000Z"); // 08:00 EST on the day the clocks went back
    const m = project(daily, "main").metrics;
    expect(m.cur.traces).toBeGreaterThan(0);
    expect(m.prev.traces).toBeGreaterThan(0);
  });
});

describe("signals roll-up fixtures (B4)", () => {
  it("plants new, resolved, spiking and control signals with their hit counts", () => {
    const signals = project(scenarioFor(), "main").signals;
    const by = (suffix: string) => signals.find((x) => x.id.endsWith(suffix))!;
    expect(by("new-a").hits).toEqual({ cur: 12, prev: 0 });
    expect(by("new-b").hits).toEqual({ cur: 4, prev: 0 });
    expect(by("resolved").status).toBe("resolved");
    expect(by("spiking").hits).toEqual({ cur: 40, prev: 5 });
    expect(by("control").hits).toEqual({ cur: 21, prev: 20 });
  });
});
