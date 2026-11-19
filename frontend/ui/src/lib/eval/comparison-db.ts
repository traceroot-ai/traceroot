/**
 * Adapters from the stored (Prisma) eval shapes to the pure comparison engine's
 * inputs. Kept separate so both the run-detail and run-list read paths derive
 * comparison from the one engine (lib/eval/comparison.ts) without duplicating the
 * mapping. These accept structurally-typed rows to avoid importing Prisma types.
 */
import type {
  ComparisonRun,
  ComparisonResult,
  ComparisonScore,
  ComparisonScorerMeta,
} from "./comparison";

interface DbScore {
  scorerName: string;
  scorerVersion: string;
  numericValue: number | null;
  boolValue: boolean | null;
  stringValue: string | null;
  error: string | null;
}

interface DbResult {
  testCaseId: string;
  status: string;
  candidateOutput: string | null;
  durationMs: number | null;
  scores: DbScore[];
}

interface DbRun {
  id: string;
  runNumber: number;
  evaluationId: string;
  datasetVersionId: string;
  candidateVersion: string;
  status: string;
  baselineRunId: string | null;
  scorers: unknown; // Json: [{ name, version, value_type?, direction?, threshold? }]
}

/** A metric's typed policy (value type, direction, threshold) read off a scorer ref or one
 *  of its emitted-metric objects, tolerating absent/unrecognised values. */
function metaOf(name: string, version: string, o: Record<string, unknown>): ComparisonScorerMeta {
  return {
    name,
    version,
    valueType:
      o.value_type === "numeric" || o.value_type === "boolean" || o.value_type === "categorical"
        ? o.value_type
        : null,
    direction:
      o.direction === "higher_is_better" ||
      o.direction === "lower_is_better" ||
      o.direction === "none"
        ? o.direction
        : null,
    threshold: typeof o.threshold === "number" ? o.threshold : null,
  };
}

/** Parse the run's `scorers` JSON into per-metric policy, keyed by the name a Score reports as
 * `scorer_name`, tolerating the old `{name,version}` shape.
 *
 * A scorer DEFINITION owns the METRICS it emits; a Score reports the emitted-metric name, never
 * the definition name. So:
 *  - when a scorer declares `emitted_metrics`, only those are surfaced (each under its own name);
 *    the definition name is NOT surfaced — it matches no Score, so it would be a phantom metric.
 *  - a scorer with no `emitted_metrics` IS its own single implicit metric (older SDK, or a metric
 *    named after the definition) — surface the definition's top-level policy.
 * Two scorers emitting the SAME metric name with a CONFLICTING policy can't be disambiguated from
 * a Score alone, so that metric drops to non-directional (null policy) rather than letting array
 * order silently pick a direction (which would flip improved↔regressed). */
export function parseScorers(json: unknown): ComparisonScorerMeta[] {
  if (!Array.isArray(json)) return [];
  const byName = new Map<string, ComparisonScorerMeta>();
  const add = (meta: ComparisonScorerMeta) => {
    const prev = byName.get(meta.name);
    if (!prev) {
      byName.set(meta.name, meta);
    } else if (
      prev.valueType !== meta.valueType ||
      prev.direction !== meta.direction ||
      prev.threshold !== meta.threshold
    ) {
      // Conflicting policy for one metric name → ambiguous; compare it non-directionally.
      byName.set(meta.name, {
        name: meta.name,
        version: prev.version,
        valueType: null,
        direction: null,
        threshold: null,
      });
    }
  };
  for (const raw of json) {
    if (!raw || typeof raw !== "object") continue;
    const o = raw as Record<string, unknown>;
    if (typeof o.name !== "string") continue;
    const version = typeof o.version === "string" ? o.version : "";
    const emitted = Array.isArray(o.emitted_metrics) ? o.emitted_metrics : [];
    if (emitted.length === 0) {
      add(metaOf(o.name, version, o));
    } else {
      for (const m of emitted) {
        if (m && typeof m === "object") {
          const em = m as Record<string, unknown>;
          if (typeof em.name === "string") add(metaOf(em.name, version, em));
        }
      }
    }
  }
  return [...byName.values()];
}

export function toComparisonRun(r: DbRun): ComparisonRun {
  return {
    id: r.id,
    runNumber: r.runNumber,
    evaluationId: r.evaluationId,
    datasetVersionId: r.datasetVersionId,
    candidateVersion: r.candidateVersion,
    status: r.status,
    baselineRunId: r.baselineRunId,
    scorers: parseScorers(r.scorers),
  };
}

export function toComparisonResults(rows: DbResult[]): ComparisonResult[] {
  return rows.map((r) => ({
    testCaseId: r.testCaseId,
    status: r.status,
    candidateOutput: r.candidateOutput,
    durationMs: r.durationMs,
    scores: r.scores.map(
      (s): ComparisonScore => ({
        scorerName: s.scorerName,
        scorerVersion: s.scorerVersion,
        numericValue: s.numericValue,
        boolValue: s.boolValue,
        stringValue: s.stringValue,
        error: s.error,
      }),
    ),
  }));
}
