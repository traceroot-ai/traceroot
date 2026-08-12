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

/** Parse the run's `scorers` JSON into typed metadata, tolerating old `{name,version}`.
 *
 * A scorer DEFINITION owns the METRICS it emits, and a Score reports the emitted-metric
 * name as `scorer_name` — never the definition name. So each `emitted_metrics[]` entry is
 * surfaced under its OWN name, carrying its own policy, alongside the definition; otherwise a
 * `grade`-emits-`quality` metric would resolve no threshold/direction in the comparison view.
 * The definition's top-level policy stays as the back-compat single implicit metric (older
 * SDK, or a scorer whose one metric is named after it). */
export function parseScorers(json: unknown): ComparisonScorerMeta[] {
  if (!Array.isArray(json)) return [];
  const out: ComparisonScorerMeta[] = [];
  for (const raw of json) {
    if (!raw || typeof raw !== "object") continue;
    const o = raw as Record<string, unknown>;
    if (typeof o.name !== "string") continue;
    const version = typeof o.version === "string" ? o.version : "";
    out.push(metaOf(o.name, version, o));
    if (Array.isArray(o.emitted_metrics)) {
      for (const m of o.emitted_metrics) {
        if (m && typeof m === "object") {
          const em = m as Record<string, unknown>;
          if (typeof em.name === "string") out.push(metaOf(em.name, version, em));
        }
      }
    }
  }
  return out;
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
