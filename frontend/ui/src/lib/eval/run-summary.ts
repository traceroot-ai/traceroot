/**
 * A run's own summary: one mean per scorer and one per derived metric, over that run's
 * results alone.
 *
 * Deliberately not the comparison engine. `compareRuns` averages only PAIRED cells, so
 * with no second run it has nothing to average and every score mean comes back null —
 * "what did this run score?" would have no answer. Here each mean is taken over the
 * results that reported the value, and `observedCount` is that denominator, so a mean
 * over three cases is not mistaken for a mean over three hundred.
 *
 * Score rows are read by the engine's own helper (`readScore`), so a run's summary and its
 * in-app comparison agree on what a stored score means.
 *
 * Never zero-filled: a result that did not report a value is left out of that mean, and a
 * mean nothing reported is null. "No data" and "measured zero" are different facts.
 */
import {
  defaultDirection,
  latestScoreByName,
  readScore,
  type ComparisonScore,
  type ComparisonScorerMeta,
  type ScorerDirection,
  type ScorerValueType,
} from "./comparison";

/** A unit the SERVER supplies, so formatting is not reinvented per client. */
export type MetricUnit = "$" | "tok" | "ms" | "count";

/** One result, as the summary reads it: its score rows and the metrics stored on it. */
export interface SummaryResult {
  scores: ComparisonScore[];
  durationMs: number | null;
  cost: number | null;
}

/**
 * The per-case metrics the summary averages, read from columns every result already
 * carries. `duration` is the whole case (task + scorers); `cost` is derived from the
 * candidate task's trace. Both are `lower_is_better`, carried on the response rather than
 * assumed, so a client that disagrees can re-read the sign itself.
 */
const RUN_METRICS = [
  { key: "duration", field: "durationMs", unit: "ms" },
  { key: "cost", field: "cost", unit: "$" },
] as const satisfies ReadonlyArray<{
  key: string;
  field: keyof SummaryResult;
  unit: MetricUnit;
}>;

export type RunMetricKey = (typeof RUN_METRICS)[number]["key"];

export interface SummaryItem {
  name: string;
  /** Null for a score: a [0,1] score is a CONVENTION, not a unit. */
  unit: MetricUnit | null;
  direction: ScorerDirection;
  /** The declared kind, else the kind observed. Every derived metric is `numeric`. */
  valueType: ScorerValueType;
  /**
   * Mean over `observedCount` results. Null when none reported a value, and always null
   * when there is no honest mean: a categorical score, or a scorer that stored labels and
   * numbers side by side.
   */
  value: number | null;
  /** How many results reported a usable value for this item. */
  observedCount: number;
}

export interface RunSummary {
  scores: SummaryItem[];
  metrics: SummaryItem[];
}

/**
 * The one row a result counts for a scorer. When a result carries several rows under one
 * name (a scorer version bump, a delayed re-score), the version the run DECLARED is the one
 * it ran with. Only when no row carries that version does the engine's own tie-break apply.
 */
function pickRows(
  scores: readonly ComparisonScore[],
  metaByName: Map<string, ComparisonScorerMeta>,
): Map<string, ComparisonScore> {
  const picked = latestScoreByName(scores);
  for (const s of scores) {
    const declared = metaByName.get(s.scorerName)?.version;
    if (declared && s.scorerVersion === declared) picked.set(s.scorerName, s);
  }
  return picked;
}

type Acc = { sum: number; numeric: number; booleans: number; labels: number };

/**
 * Folds score rows into per-scorer means one result at a time, so a caller can feed a large
 * run in pages and never hold all of it. `summarizeRun` is the whole-list form.
 *
 * `scorers` is the run's declared manifest (`parseScorers`): those are listed first, in
 * declared order, even when nothing scored — an empty row is itself information. Any other
 * scorer the results carry follows, ordered by name, including one that only ever errored.
 */
export class ScoreSummarizer {
  private readonly metaByName: Map<string, ComparisonScorerMeta>;
  private readonly acc = new Map<string, Acc>();

  constructor(private readonly scorers: readonly ComparisonScorerMeta[]) {
    this.metaByName = new Map(scorers.map((s) => [s.name, s]));
  }

  /** Add one result's score rows. */
  add(scores: readonly ComparisonScore[]): void {
    for (const [name, score] of pickRows(scores, this.metaByName)) {
      const a = this.acc.get(name) ?? { sum: 0, numeric: 0, booleans: 0, labels: 0 };
      this.acc.set(name, a);
      const v = readScore(score);
      // An errored or empty row is not an observation: it lowers no mean.
      if (v.kind !== "value") continue;
      if (v.valueType === "categorical") {
        a.labels += 1;
        continue;
      }
      const x = v.valueType === "boolean" ? (v.value ? 1 : 0) : (v.value as number);
      // A non-finite stored value can never poison a mean.
      if (!Number.isFinite(x)) continue;
      a.sum += x;
      a.numeric += 1;
      if (v.valueType === "boolean") a.booleans += 1;
    }
  }

  /** One item per scorer. */
  items(): SummaryItem[] {
    const declaredNames = this.scorers.map((s) => s.name);
    const declared = new Set(declaredNames);
    const undeclared = [...this.acc.keys()].filter((n) => !declared.has(n)).sort();
    return [...new Set([...declaredNames, ...undeclared])].map((name): SummaryItem => {
      const meta = this.metaByName.get(name);
      const a = this.acc.get(name) ?? { sum: 0, numeric: 0, booleans: 0, labels: 0 };
      const observed: ScorerValueType | null =
        a.labels > 0
          ? "categorical" // labels alone, or labels beside numbers: no single numeric reading
          : a.numeric > 0
            ? a.booleans === a.numeric
              ? "boolean"
              : "numeric"
            : null;
      const valueType = meta?.valueType ?? observed ?? "numeric";
      // A mean only over values all of ONE kind. A label among them, or booleans beside
      // plain numbers, means the instrument changed (the engine calls that type_mismatch),
      // so no single mean is honest.
      const oneKind = a.labels === 0 && (a.booleans === 0 || a.booleans === a.numeric);
      const averaged = valueType !== "categorical" && oneKind && a.numeric > 0;
      return {
        name,
        unit: null,
        direction: meta?.direction ?? defaultDirection(valueType),
        valueType,
        value: averaged ? a.sum / a.numeric : null,
        observedCount: a.numeric + a.labels,
      };
    });
  }
}

/** One stored metric's item, from its mean and how many results reported it. */
export function metricSummary(
  key: RunMetricKey,
  mean: number | null,
  observedCount: number,
): SummaryItem {
  const m = RUN_METRICS.find((x) => x.key === key)!;
  return {
    name: m.key,
    unit: m.unit,
    direction: "lower_is_better",
    valueType: "numeric",
    value: observedCount > 0 ? mean : null,
    observedCount,
  };
}

/** Summarize one run from its whole list of results. */
export function summarizeRun(
  scorers: readonly ComparisonScorerMeta[],
  results: readonly SummaryResult[],
): RunSummary {
  const summarizer = new ScoreSummarizer(scorers);
  for (const r of results) summarizer.add(r.scores);

  // Projected in RUN_METRICS order so a client renders a stable table. A metric nothing
  // reported still appears, with a null value — omitting it would look like the metric
  // does not exist.
  const metrics = RUN_METRICS.map((m): SummaryItem => {
    let sum = 0;
    let n = 0;
    for (const r of results) {
      const x = r[m.field];
      if (x == null || !Number.isFinite(x)) continue;
      sum += x;
      n += 1;
    }
    return metricSummary(m.key, n > 0 ? sum / n : null, n);
  });

  return { scores: summarizer.items(), metrics };
}
