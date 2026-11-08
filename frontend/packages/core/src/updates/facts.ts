/**
 * The numbers of an update, computed in code.
 *
 * The model never does arithmetic: it receives these findings, with their
 * direction and size already worked out, and narrates them. A change is only
 * reported as a change when both windows have enough traffic and the movement
 * is big enough to matter; below that the finding carries absolute numbers and
 * no percentage. An entity that exists in only one window is a categorical
 * finding (new or vanished), never a percentage.
 *
 * The thresholds below are starting points. They are not tuned on real
 * projects yet and live in one object so they can be.
 */
import type { WindowAggregates } from "./aggregates.ts";

export interface NoiseRules {
  /** Fewest traces (or calls) each window needs before a rate or latency change is compared. */
  minSample: number;
  /** `minFailures` is the smallest change in the number of failed traces worth a finding. */
  errorRate: { minAbs: number; minRel: number; minFailures: number; minZ: number };
  /** `minBase` is the smallest earlier value a percentage may be shown against. */
  volume: { minAbs: number; minRel: number; minBase: number };
  /** `minSample` is the fewest traces each window needs for a percentile comparison. */
  latencyMs: { minAbs: number; minRel: number; minSample: number };
  /** `minCalls` is the fewest model calls each window needs for a percentage. */
  costUsd: { minAbs: number; minRel: number; minBase: number; minCalls: number };
  tokens: { minAbs: number; minRel: number; minBase: number; minCalls: number };
  toolCalls: { minAbs: number; minRel: number; minBase: number };
}

export const DEFAULT_NOISE_RULES: NoiseRules = {
  minSample: 30,
  errorRate: { minAbs: 0.02, minRel: 0.25, minFailures: 3, minZ: 2.5 },
  volume: { minAbs: 20, minRel: 0.25, minBase: 30 },
  latencyMs: { minAbs: 200, minRel: 0.25, minSample: 200 },
  costUsd: { minAbs: 0.25, minRel: 0.3, minBase: 0.1, minCalls: 30 },
  tokens: { minAbs: 50_000, minRel: 0.3, minBase: 5_000, minCalls: 30 },
  toolCalls: { minAbs: 20, minRel: 0.3, minBase: 30 },
};

export type FindingScope = "project" | "workflow" | "model" | "tool";
export type FindingMetric =
  | "trace_volume"
  | "error_rate"
  | "latency_p50"
  | "latency_p95"
  | "cost"
  | "tokens"
  | "tool_calls"
  | "presence";
export type FindingKind = "change" | "new" | "vanished" | "absolute_only";

export interface Finding {
  /** Stable across runs for the same entity and metric, so repeats can be recognised. */
  id: string;
  kind: FindingKind;
  scope: FindingScope;
  entity: string;
  metric: FindingMetric;
  direction: "up" | "down" | "appeared" | "vanished";
  before: number;
  after: number;
  absoluteChange: number;
  /** Null when no percentage may be shown: a new item, or too small a sample. */
  relativeChange: number | null;
  /** Sample sizes behind a rate, as [before, after]. */
  samples?: [number, number];
  note?: string;
  /** The finding as one line of text, worked out in code: the form to quote. */
  display: string;
}

/** A finding before its display line is written. */
type Draft = Omit<Finding, "display">;

export interface OverviewMetric {
  current: number;
  previous: number;
  absoluteChange: number;
  relativeChange: number | null;
}

export interface UpdateFacts {
  window: { start: string; end: string };
  previousWindow: { start: string; end: string };
  overview: {
    traces: OverviewMetric;
    errorRate: OverviewMetric;
    latencyP50Ms: OverviewMetric;
    latencyP95Ms: OverviewMetric;
    llmCostUsd: OverviewMetric;
    totalTokens: OverviewMetric;
  };
  findings: Finding[];
  /** The overview as lines to quote: the same numbers, formatted. */
  overviewLines: string[];
  /** The top models by spend this window, with shares worked out in code. */
  topModels: {
    model: string;
    costUsd: number;
    shareOfCost: number;
    previousCostUsd: number;
    totalTokens: number;
  }[];
  /** Lists cut at the entity cap; new and vanished items of these are not reported. */
  truncatedLists: string[];
  /** Cost and tokens by model and day for the current window, for the weekly view. */
  modelDays: { model: string; day: string; totalTokens: number; costUsd: number }[];
  /** The project's timezone, set by the run; `window` is in UTC. */
  timezone?: string;
  hasGitContext: boolean;
  /** No traffic in either window, or traffic with nothing past the thresholds. */
  nothingNotable: boolean;
  /** Why there is nothing notable, when there is nothing. */
  nothingNotableReason: "no_traffic" | "no_significant_change" | null;
}

const round = (value: number, places = 6) => {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
};

function relative(before: number, after: number): number | null {
  return before === 0 ? null : round((after - before) / before);
}

/**
 * A percentage in the overview appears only when the same movement is a finding:
 * it passed the minimum sample, size and significance rules.
 */
function shows(findings: Draft[], id: string): boolean {
  return findings.some((f) => f.id === id && f.kind === "change");
}

/** `showPercent` is false when the base or the sample is too small for a percentage. */
function metric(current: number, previous: number, showPercent: boolean): OverviewMetric {
  return {
    current: round(current),
    previous: round(previous),
    absoluteChange: round(current - previous),
    relativeChange: showPercent ? relative(previous, current) : null,
  };
}

const number = (value: number, places = 0) =>
  value.toLocaleString("en-US", { minimumFractionDigits: places, maximumFractionDigits: places });
const signed = (value: number, text: string) => `${value < 0 ? "-" : "+"}${text}`;
const percent = (fraction: number) =>
  `${number(Math.abs(fraction) * 100, Math.abs(fraction) >= 0.1 ? 0 : 1)}%`;
const dollars = (value: number) => `$${number(value, 2)}`;

/** One line for a finding: the numbers as a reader should be given them. */
function displayOf(f: Draft): string {
  const rel =
    f.relativeChange === null ? "" : ` (${signed(f.relativeChange, percent(f.relativeChange))})`;
  switch (f.metric) {
    case "trace_volume":
      return `${f.entity}: ${number(f.before)} to ${number(f.after)} traces${rel}`;
    case "error_rate":
      if (f.kind === "absolute_only") return `${f.entity}: ${f.note}`;
      return `${f.entity}: error rate ${percent(f.before)} to ${percent(f.after)} (${signed(f.absoluteChange, number(Math.abs(f.absoluteChange) * 100, 1))} percentage points)${f.samples ? `, from ${number(f.samples[0])} and ${number(f.samples[1])} traces` : ""}`;
    case "latency_p50":
    case "latency_p95":
      return `${f.entity}: ${f.metric === "latency_p50" ? "median" : "95th percentile"} latency ${number(f.before)} ms to ${number(f.after)} ms${rel}`;
    case "cost":
      return `${f.entity}: cost ${dollars(f.before)} to ${dollars(f.after)}${rel}`;
    case "tokens":
      return `${f.entity}: ${number(f.before)} to ${number(f.after)} tokens${rel}`;
    case "tool_calls":
      return `${f.entity}: ${number(f.before)} to ${number(f.after)} calls${rel}`;
    case "presence":
      return f.kind === "new"
        ? `${f.entity}: new this window (${number(f.after)} uses, none before)`
        : `${f.entity}: no longer used (${number(f.before)} uses before, none now)`;
  }
}

const direction = (before: number, after: number): "up" | "down" =>
  after > before ? "up" : "down";

function passes(before: number, after: number, rule: { minAbs: number; minRel: number }): boolean {
  const abs = Math.abs(after - before);
  if (abs < rule.minAbs) return false;
  if (before === 0) return true;
  return abs / Math.abs(before) >= rule.minRel;
}

function change(
  scope: FindingScope,
  entity: string,
  m: FindingMetric,
  before: number,
  after: number,
  samples?: [number, number],
): Draft {
  return {
    id: `${scope}:${entity}:${m}`,
    kind: "change",
    scope,
    entity,
    metric: m,
    direction: direction(before, after),
    before: round(before),
    after: round(after),
    absoluteChange: round(after - before),
    relativeChange: relative(before, after),
    ...(samples ? { samples } : {}),
  };
}

/**
 * A scalar movement (volume, cost, tokens, calls). Big enough to matter, and
 * measured against a base large enough for a percentage; otherwise the numbers
 * are shown as they are, without one.
 */
function scalar(
  scope: FindingScope,
  entity: string,
  m: FindingMetric,
  before: number,
  after: number,
  rule: { minAbs: number; minRel: number; minBase: number },
  /** Number of events behind each side; a percentage needs this many in both. */
  support?: { calls: [number, number]; minCalls: number },
): Draft[] {
  if (!passes(before, after, rule)) return [];
  const supported = !support || Math.min(...support.calls) >= support.minCalls;
  if (before >= rule.minBase && supported) return [change(scope, entity, m, before, after)];
  return [
    {
      ...change(scope, entity, m, before, after),
      kind: "absolute_only",
      relativeChange: null,
      note: "the earlier value is too small to show as a percentage",
    },
  ];
}

/** An item seen fewer times than this is not worth calling new or gone. */
const MIN_CATEGORICAL_COUNT = 3;

function categorical(
  scope: FindingScope,
  entity: string,
  kind: "new" | "vanished",
  count: number,
): Draft {
  const appeared = kind === "new";
  return {
    id: `${scope}:${entity}:presence`,
    kind,
    scope,
    entity,
    metric: "presence",
    direction: appeared ? "appeared" : "vanished",
    before: appeared ? 0 : count,
    after: appeared ? count : 0,
    absoluteChange: appeared ? count : -count,
    relativeChange: null,
    note: appeared ? "not seen in the previous window" : "not seen in this window",
  };
}

/** Two-proportion z statistic with a pooled rate: how far apart the rates are, in standard errors. */
export function zScore(
  before: { failures: number; total: number },
  after: { failures: number; total: number },
): number {
  const total = before.total + after.total;
  if (before.total === 0 || after.total === 0 || total === 0) return 0;
  const pooled = (before.failures + after.failures) / total;
  const error = Math.sqrt(pooled * (1 - pooled) * (1 / before.total + 1 / after.total));
  if (error === 0) return 0;
  return (after.failures / after.total - before.failures / before.total) / error;
}

interface RateSide {
  failures: number;
  total: number;
}

function rateFindings(
  scope: FindingScope,
  entity: string,
  before: RateSide,
  after: RateSide,
  rules: NoiseRules,
): Draft[] {
  const rateBefore = before.total === 0 ? 0 : before.failures / before.total;
  const rateAfter = after.total === 0 ? 0 : after.failures / after.total;
  const samples: [number, number] = [before.total, after.total];
  if (before.total >= rules.minSample && after.total >= rules.minSample) {
    return passes(rateBefore, rateAfter, rules.errorRate) &&
      Math.abs(after.failures - before.failures) >= rules.errorRate.minFailures &&
      Math.abs(zScore(before, after)) >= rules.errorRate.minZ
      ? [change(scope, entity, "error_rate", rateBefore, rateAfter, samples)]
      : [];
  }
  // Too little traffic for a rate. Show the counts, and only when they differ.
  if (Math.abs(after.failures - before.failures) < 2 || before.total + after.total === 0) return [];
  return [
    {
      id: `${scope}:${entity}:error_rate`,
      kind: "absolute_only",
      scope,
      entity,
      metric: "error_rate",
      direction: direction(before.failures, after.failures),
      before: before.failures,
      after: after.failures,
      absoluteChange: after.failures - before.failures,
      relativeChange: null,
      samples,
      note: `${after.failures} of ${after.total} failed now, ${before.failures} of ${before.total} before: too few traces to compare as a rate`,
    },
  ];
}

function latencyFindings(
  scope: FindingScope,
  entity: string,
  before: { traces: number; p50Ms: number; p95Ms: number },
  after: { traces: number; p50Ms: number; p95Ms: number },
  rules: NoiseRules,
): Draft[] {
  if (before.traces < rules.latencyMs.minSample || after.traces < rules.latencyMs.minSample)
    return [];
  const samples: [number, number] = [before.traces, after.traces];
  const out: Draft[] = [];
  if (passes(before.p50Ms, after.p50Ms, rules.latencyMs)) {
    out.push(change(scope, entity, "latency_p50", before.p50Ms, after.p50Ms, samples));
  }
  if (passes(before.p95Ms, after.p95Ms, rules.latencyMs)) {
    out.push(change(scope, entity, "latency_p95", before.p95Ms, after.p95Ms, samples));
  }
  return out;
}

function volumeFinding(
  scope: FindingScope,
  entity: string,
  before: number,
  after: number,
  rules: NoiseRules,
): Draft[] {
  // Counts vary by chance: the difference must also stand out against sqrt(before + after).
  if (before + after > 0 && Math.abs(after - before) / Math.sqrt(before + after) < 3) return [];
  return scalar(scope, entity, "trace_volume", before, after, rules.volume);
}

function overviewLines(
  c: WindowAggregates["totals"],
  p: WindowAggregates["totals"],
  costNow: number,
  costBefore: number,
  current: WindowAggregates,
  previous: WindowAggregates,
  errorRateMoved: boolean,
): string[] {
  const change = (before: number, after: number, minBase: number) =>
    before >= minBase && before !== 0
      ? ` (${signed(after - before, percent((after - before) / before))})`
      : "";
  const rate = (a: number, b: number) => (b === 0 ? 0 : a / b);
  return [
    `Traces: ${number(p.traces)} to ${number(c.traces)}${change(p.traces, c.traces, DEFAULT_NOISE_RULES.volume.minBase)}`,
    `Error rate: ${percent(rate(p.errorTraces, p.traces))} to ${percent(rate(c.errorTraces, c.traces))} (${number(p.errorTraces)} of ${number(p.traces)} traces, then ${number(c.errorTraces)} of ${number(c.traces)})${errorRateMoved ? "" : ", not a significant change"}`,
    `Latency: median ${number(p.p50Ms)} ms to ${number(c.p50Ms)} ms, 95th percentile ${number(p.p95Ms)} ms to ${number(c.p95Ms)} ms`,
    `Model spend: ${dollars(costBefore)} to ${dollars(costNow)}${change(costBefore, costNow, DEFAULT_NOISE_RULES.costUsd.minBase)}`,
    `Tokens: ${number(previous.llm.totalTokens)} to ${number(current.llm.totalTokens)}`,
  ];
}

/** Compare a window with the one before it. Pure: the same inputs give the same findings. */
export function computeUpdateFacts(
  current: WindowAggregates,
  previous: WindowAggregates,
  rules: NoiseRules = DEFAULT_NOISE_RULES,
): UpdateFacts {
  const findings: Draft[] = [];
  // A list cut at the entity cap cannot tell new from merely beyond the cap.
  const cut = new Set([...current.truncated, ...previous.truncated]);
  const c = current.totals;
  const p = previous.totals;

  findings.push(...volumeFinding("project", "all traffic", p.traces, c.traces, rules));
  findings.push(
    ...rateFindings(
      "project",
      "all traffic",
      { failures: p.errorTraces, total: p.traces },
      { failures: c.errorTraces, total: c.traces },
      rules,
    ),
  );
  findings.push(...latencyFindings("project", "all traffic", p, c, rules));
  const costNow = Number(current.llm.cost);
  const costBefore = Number(previous.llm.cost);
  const llmCalls: [number, number] = [previous.llm.calls, current.llm.calls];
  findings.push(
    ...scalar("project", "all models", "cost", costBefore, costNow, rules.costUsd, {
      calls: llmCalls,
      minCalls: rules.costUsd.minCalls,
    }),
  );
  findings.push(
    ...scalar(
      "project",
      "all models",
      "tokens",
      previous.llm.totalTokens,
      current.llm.totalTokens,
      rules.tokens,
      { calls: llmCalls, minCalls: rules.tokens.minCalls },
    ),
  );

  // Workflows: volume, errors and latency, and the ones that appeared or went.
  const prevWorkflows = new Map(previous.workflows.map((w) => [w.name, w]));
  const curWorkflows = new Map(current.workflows.map((w) => [w.name, w]));
  for (const [name, now] of curWorkflows) {
    const before = prevWorkflows.get(name);
    if (!before) {
      if (!cut.has("workflows") && now.traces >= MIN_CATEGORICAL_COUNT)
        findings.push(categorical("workflow", name, "new", now.traces));
      continue;
    }
    findings.push(...volumeFinding("workflow", name, before.traces, now.traces, rules));
    findings.push(
      ...rateFindings(
        "workflow",
        name,
        { failures: before.errorTraces, total: before.traces },
        { failures: now.errorTraces, total: now.traces },
        rules,
      ),
    );
    findings.push(...latencyFindings("workflow", name, before, now, rules));
  }
  for (const [name, before] of prevWorkflows) {
    if (
      !curWorkflows.has(name) &&
      !cut.has("workflows") &&
      before.traces >= MIN_CATEGORICAL_COUNT
    ) {
      findings.push(categorical("workflow", name, "vanished", before.traces));
    }
  }

  // Models: cost and tokens, and the ones that appeared or went.
  const prevModels = new Map(previous.byModel.map((m) => [m.model, m]));
  const curModels = new Map(current.byModel.map((m) => [m.model, m]));
  for (const [name, now] of curModels) {
    const before = prevModels.get(name);
    if (!before) {
      if (!cut.has("models") && now.calls >= MIN_CATEGORICAL_COUNT)
        findings.push(categorical("model", name, "new", now.calls));
      continue;
    }
    findings.push(
      ...scalar("model", name, "cost", Number(before.cost), Number(now.cost), rules.costUsd, {
        calls: [before.calls, now.calls],
        minCalls: rules.costUsd.minCalls,
      }),
    );
    findings.push(
      ...scalar("model", name, "tokens", before.totalTokens, now.totalTokens, rules.tokens, {
        calls: [before.calls, now.calls],
        minCalls: rules.tokens.minCalls,
      }),
    );
  }
  for (const [name, before] of prevModels) {
    if (!curModels.has(name))
      if (!cut.has("models") && before.calls >= MIN_CATEGORICAL_COUNT)
        findings.push(categorical("model", name, "vanished", before.calls));
  }

  // Tools.
  const prevTools = new Map(previous.tools.map((t) => [t.name, t]));
  const curTools = new Map(current.tools.map((t) => [t.name, t]));
  for (const [name, now] of curTools) {
    const before = prevTools.get(name);
    if (!before) {
      if (!cut.has("tools") && now.calls >= MIN_CATEGORICAL_COUNT)
        findings.push(categorical("tool", name, "new", now.calls));
      continue;
    }
    if (Math.abs(now.calls - before.calls) / Math.sqrt(now.calls + before.calls) >= 3) {
      findings.push(
        ...scalar("tool", name, "tool_calls", before.calls, now.calls, rules.toolCalls),
      );
    }
    findings.push(
      ...rateFindings(
        "tool",
        name,
        { failures: before.errors, total: before.calls },
        { failures: now.errors, total: now.calls },
        rules,
      ),
    );
  }
  for (const [name, before] of prevTools) {
    if (!curTools.has(name))
      if (!cut.has("tools") && before.calls >= MIN_CATEGORICAL_COUNT)
        findings.push(categorical("tool", name, "vanished", before.calls));
  }

  findings.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const empty = c.traces === 0 && p.traces === 0;
  const totalCost = costNow;
  const previousCosts = new Map(previous.byModel.map((m) => [m.model, Number(m.cost)]));
  const topModels = [...current.byModel]
    .sort((a, b) => Number(b.cost) - Number(a.cost) || (a.model < b.model ? -1 : 1))
    .slice(0, 5)
    .map((m) => ({
      model: m.model,
      costUsd: Number(m.cost),
      shareOfCost: totalCost > 0 ? round(Number(m.cost) / totalCost, 4) : 0,
      previousCostUsd: previousCosts.get(m.model) ?? 0,
      totalTokens: m.totalTokens,
    }));
  const nothingNotable = findings.length === 0;
  return {
    window: { start: current.start, end: current.end },
    previousWindow: { start: previous.start, end: previous.end },
    overview: {
      traces: metric(c.traces, p.traces, shows(findings, "project:all traffic:trace_volume")),
      errorRate: metric(
        c.traces === 0 ? 0 : c.errorTraces / c.traces,
        p.traces === 0 ? 0 : p.errorTraces / p.traces,
        shows(findings, "project:all traffic:error_rate"),
      ),
      latencyP50Ms: metric(c.p50Ms, p.p50Ms, shows(findings, "project:all traffic:latency_p50")),
      latencyP95Ms: metric(c.p95Ms, p.p95Ms, shows(findings, "project:all traffic:latency_p95")),
      llmCostUsd: metric(costNow, costBefore, shows(findings, "project:all models:cost")),
      totalTokens: metric(
        current.llm.totalTokens,
        previous.llm.totalTokens,
        shows(findings, "project:all models:tokens"),
      ),
    },
    overviewLines: overviewLines(
      c,
      p,
      costNow,
      costBefore,
      current,
      previous,
      shows(findings, "project:all traffic:error_rate"),
    ),
    topModels,
    truncatedLists: [...cut].sort(),
    findings: findings.map((f) => ({ ...f, display: displayOf(f) })),
    modelDays: current.byModelDay.map((d) => ({
      model: d.model,
      day: d.day,
      totalTokens: d.totalTokens,
      costUsd: Number(d.cost),
    })),
    hasGitContext: c.gitContextTraces > 0,
    nothingNotable,
    nothingNotableReason: empty ? "no_traffic" : nothingNotable ? "no_significant_change" : null,
  };
}
