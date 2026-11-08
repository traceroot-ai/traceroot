import { describe, expect, it } from "vitest";
import { computeUpdateFacts, type WindowAggregates } from "@traceroot/core/updates";
import { checkFacts } from "../check-facts.js";
import { buildManifest } from "../manifest.js";
import type { WindowMetrics } from "../measure.js";
import { buildScenario, defaultParams } from "../scenario.js";

const SHAS = { base: "a".repeat(40), bad: "b".repeat(40), ctl: "c".repeat(40) };

/** The aggregates ClickHouse would return for the manifest's own numbers. */
function aggregatesOf(
  m: WindowMetrics,
  start: string,
  end: string,
  gitTraces: number,
): WindowAggregates {
  const group = (name: string, g: WindowMetrics["byWorkflow"][string]) => ({
    name,
    traces: g.traces,
    errorTraces: g.errorTraces,
    p50Ms: g.p50Ms,
    p95Ms: g.p95Ms,
  });
  return {
    start,
    end,
    totals: {
      traces: m.traces,
      errorTraces: m.errorTraces,
      p50Ms: m.p50Ms,
      p95Ms: m.p95Ms,
      p99Ms: m.p95Ms,
      gitContextTraces: gitTraces,
    },
    llm: {
      calls: m.llmCalls,
      inputTokens: m.inputTokens,
      outputTokens: m.outputTokens,
      totalTokens: m.totalTokens,
      cost: m.cost,
    },
    byModel: Object.entries(m.byModel).map(([model, v]) => ({ model, ...v })),
    byModelDay: [],
    tools: Object.entries(m.byTool).map(([name, v]) => ({ name, ...v })),
    workflows: Object.entries(m.byWorkflow).map(([name, g]) => group(name, g)),
    refs: [],
  };
}

const scenario = buildScenario(defaultParams(), SHAS);
const manifest = buildManifest(scenario, {} as never);

function facts(key: string, tweak?: (cur: WindowAggregates) => void) {
  const p = scenario.projects.find((x) => x.key === key)!;
  const cur = aggregatesOf(
    p.metrics.cur,
    manifest.windows.current.start,
    manifest.windows.current.end,
    p.metrics.cur.traces,
  );
  const prev = aggregatesOf(
    p.metrics.prev,
    manifest.windows.previous.start,
    manifest.windows.previous.end,
    0,
  );
  tweak?.(cur);
  return computeUpdateFacts(cur, prev);
}

describe("facts against the planted ground truth (B2, B3)", () => {
  it("finds every planted change in the main project and flags no control", () => {
    expect(checkFacts(manifest, "main", facts("main"))).toEqual([]);
  });

  it("agrees for the other seeded projects", () => {
    for (const key of ["nogit", "tiny", "empty", "other"]) {
      expect(checkFacts(manifest, key, facts(key))).toEqual([]);
    }
  });

  it("notices a missing planted change", () => {
    const flat = facts("main", (cur) => {
      cur.workflows = cur.workflows.map((w) =>
        w.name === "checkout_agent" ? { ...w, traces: 300, errorTraces: 9 } : w,
      );
    });
    expect(checkFacts(manifest, "main", flat).join("\n")).toContain("volume-drop-checkout");
  });

  it("notices a flagged control", () => {
    const noisy = facts("main", (cur) => {
      cur.workflows = cur.workflows.map((w) =>
        w.name === "support_agent" ? { ...w, errorTraces: w.errorTraces * 4 } : w,
      );
    });
    expect(checkFacts(manifest, "main", noisy).join("\n")).toContain(
      "control support_agent was flagged",
    );
  });

  it("notices an invented finding", () => {
    const invented = facts("main", (cur) => {
      cur.tools = [...cur.tools, { name: "brand_new_tool", calls: 50, errors: 0 }];
    });
    expect(checkFacts(manifest, "main", invented).join("\n")).toContain(
      "invented finding tool:brand_new_tool",
    );
  });

  it("shows the tiny project as counts only and the empty project as no traffic", () => {
    const tiny = facts("tiny");
    expect(tiny.findings.find((f) => f.id === "project:all traffic:error_rate")).toMatchObject({
      kind: "absolute_only",
      relativeChange: null,
    });
    expect(facts("empty")).toMatchObject({
      nothingNotable: true,
      nothingNotableReason: "no_traffic",
    });
  });
});
