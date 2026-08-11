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

/** Parse the run's `scorers` JSON into typed metadata, tolerating old `{name,version}`. */
export function parseScorers(json: unknown): ComparisonScorerMeta[] {
  if (!Array.isArray(json)) return [];
  const out: ComparisonScorerMeta[] = [];
  for (const raw of json) {
    if (!raw || typeof raw !== "object") continue;
    const o = raw as Record<string, unknown>;
    if (typeof o.name !== "string") continue;
    out.push({
      name: o.name,
      version: typeof o.version === "string" ? o.version : "",
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
    });
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
