import type { Finding, UpdateFacts, WindowAggregates } from "@traceroot/core/updates";
import type { buildManifest } from "./manifest.js";

type Manifest = ReturnType<typeof buildManifest>;

const KIND_TO_FINDING: Record<
  string,
  {
    scope: Finding["scope"];
    metric: Finding["metric"];
    kind: Finding["kind"];
    direction: Finding["direction"];
  }
> = {
  volume_drop: { scope: "workflow", metric: "trace_volume", kind: "change", direction: "down" },
  error_rate_rise: { scope: "workflow", metric: "error_rate", kind: "change", direction: "up" },
  cost_spike: { scope: "model", metric: "cost", kind: "change", direction: "up" },
  latency_shift: { scope: "workflow", metric: "latency_p50", kind: "change", direction: "up" },
  new_tool: { scope: "tool", metric: "presence", kind: "new", direction: "appeared" },
  vanished_tool: { scope: "tool", metric: "presence", kind: "vanished", direction: "vanished" },
};

/**
 * Grade the computed facts of one seeded project against the manifest: each
 * planted change is found with the right direction and a magnitude within its
 * tolerance, no control is flagged, nothing is invented, and the small-sample
 * and empty projects behave as the noise rules say. Returns the problems; an
 * empty list means the facts agree with the planted ground truth.
 */
export function checkFacts(manifest: Manifest, projectKey: string, facts: UpdateFacts): string[] {
  const problems: string[] = [];
  const project = manifest.projects[projectKey as keyof Manifest["projects"]];
  const changes = manifest.plantedChanges.filter((c) => c.project === project.id);
  const explained = new Set<string>();

  for (const change of changes) {
    const want = KIND_TO_FINDING[change.kind];
    const id = `${want.scope}:${change.entity}:${want.metric}`;
    const finding = facts.findings.find((f) => f.id === id);
    explained.add(`${want.scope}:${change.entity}`);
    if (!finding) {
      problems.push(`planted change ${change.id}: no finding ${id}`);
      continue;
    }
    if (finding.kind !== want.kind)
      problems.push(`${id}: kind ${finding.kind}, expected ${want.kind}`);
    if (finding.direction !== want.direction) {
      problems.push(`${id}: direction ${finding.direction}, expected ${want.direction}`);
    }
    if (
      change.before !== null &&
      change.after !== null &&
      change.before > 0 &&
      want.kind === "change"
    ) {
      const plantedRatio = change.after / change.before;
      const foundRatio = finding.after / finding.before;
      if (Math.abs(foundRatio - plantedRatio) / plantedRatio > change.tolerance) {
        problems.push(
          `${id}: ratio ${foundRatio.toFixed(3)}, planted ${plantedRatio.toFixed(3)} (tolerance ${change.tolerance})`,
        );
      }
    }
    if (want.kind !== "change" && finding.relativeChange !== null) {
      problems.push(`${id}: a ${want.kind} item must not carry a percentage`);
    }
  }

  for (const control of manifest.controls.filter((c) => c.project === project.id)) {
    const flagged = facts.findings.filter(
      (f) => f.entity === control.entity && f.scope !== "project",
    );
    if (flagged.length > 0) {
      problems.push(
        `control ${control.entity} was flagged: ${flagged.map((f) => f.id).join(", ")}`,
      );
    }
  }

  const derived = new Set<string>(
    manifest.derivedEntities[projectKey as keyof Manifest["derivedEntities"]],
  );
  for (const finding of facts.findings) {
    if (finding.scope === "project") continue;
    const key = `${finding.scope}:${finding.entity}`;
    if (!explained.has(key) && !derived.has(key)) problems.push(`invented finding ${finding.id}`);
  }

  if (projectKey === "tiny") {
    if (facts.findings.some((f) => f.kind === "change" && f.metric !== "presence")) {
      problems.push("tiny sample: a percentage change was reported");
    }
    const rate = facts.findings.find((f) => f.id === "project:all traffic:error_rate");
    if (!rate || rate.kind !== "absolute_only")
      problems.push("tiny sample: error counts not shown as absolute numbers");
  }
  if (projectKey === "empty") {
    if (!facts.nothingNotable || facts.nothingNotableReason !== "no_traffic") {
      problems.push("empty project: expected nothing notable for no traffic");
    }
  }
  return problems;
}

const nano = (text: string | number): bigint => {
  const [whole, frac = ""] = String(text).split(".");
  return BigInt(whole) * 1_000_000_000n + BigInt(frac.padEnd(9, "0").slice(0, 9));
};

/**
 * The aggregate endpoint's answer for one window against the manifest, to the
 * digit: totals, percentiles, tokens and cost, and every model, model and day,
 * tool, workflow and ref.
 */
export function checkAggregates(
  manifest: Manifest,
  projectKey: string,
  windowName: "current" | "previous",
  agg: WindowAggregates,
): string[] {
  const expected = manifest.projects[projectKey as keyof Manifest["projects"]].expected[windowName];
  const problems: string[] = [];
  const label = `${projectKey}/${windowName}`;
  const eq = (what: string, actual: unknown, want: unknown) => {
    if (String(actual) !== String(want))
      problems.push(`${label} ${what}: got ${actual}, expected ${want}`);
  };
  eq("traces", agg.totals.traces, expected.traces);
  eq("errorTraces", agg.totals.errorTraces, expected.errorTraces);
  if (expected.traces > 0) {
    eq("p50Ms", agg.totals.p50Ms, expected.p50Ms);
    eq("p95Ms", agg.totals.p95Ms, expected.p95Ms);
  }
  eq("llmCalls", agg.llm.calls, expected.llmCalls);
  eq("totalTokens", agg.llm.totalTokens, expected.totalTokens);
  eq("cost", nano(agg.llm.cost), nano(expected.cost));
  eq(
    "models",
    agg.byModel
      .map((m) => m.model)
      .sort()
      .join(),
    Object.keys(expected.byModel).join(),
  );
  for (const m of agg.byModel) {
    const e = expected.byModel[m.model];
    if (!e) continue;
    eq(`${m.model} calls`, m.calls, e.calls);
    eq(`${m.model} cost`, nano(m.cost), nano(e.cost));
  }
  eq("model-day cells", agg.byModelDay.length, Object.keys(expected.byModelDay).length);
  for (const d of agg.byModelDay) {
    const e = expected.byModelDay[`${d.model}|${d.day}`];
    if (!e) problems.push(`${label} unexpected model-day ${d.model}|${d.day}`);
    else {
      eq(`${d.model} ${d.day} tokens`, d.totalTokens, e.totalTokens);
      eq(`${d.model} ${d.day} cost`, nano(d.cost), nano(e.cost));
    }
  }
  eq(
    "tools",
    agg.tools
      .map((t) => t.name)
      .sort()
      .join(),
    Object.keys(expected.byTool).join(),
  );
  for (const t of agg.tools) {
    const e = expected.byTool[t.name];
    if (e) {
      eq(`tool ${t.name} calls`, t.calls, e.calls);
      eq(`tool ${t.name} errors`, t.errors, e.errors);
    }
  }
  eq(
    "workflows",
    agg.workflows
      .map((w) => w.name)
      .sort()
      .join(),
    Object.keys(expected.byWorkflow).join(),
  );
  for (const w of agg.workflows) {
    const e = expected.byWorkflow[w.name];
    if (e) {
      eq(`${w.name} traces`, w.traces, e.traces);
      eq(`${w.name} errors`, w.errorTraces, e.errorTraces);
      eq(`${w.name} p95`, w.p95Ms, e.p95Ms);
    }
  }
  eq(
    "refs",
    agg.refs
      .map((r) => r.name)
      .sort()
      .join(),
    Object.keys(expected.byRef).sort().join(),
  );
  for (const r of agg.refs) {
    const e = expected.byRef[r.name];
    if (e) {
      eq(`ref ${r.name.slice(0, 7)} traces`, r.traces, e.traces);
      eq(`ref ${r.name.slice(0, 7)} errors`, r.errorTraces, e.errorTraces);
    }
  }
  return problems;
}
