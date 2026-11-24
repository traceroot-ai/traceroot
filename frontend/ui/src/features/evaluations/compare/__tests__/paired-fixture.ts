import type { ResultRow, RunDetail, ScoreRow } from "../../types";
import type { RunBundle } from "../model";

/**
 * Three runs of one dataset (12 cases) whose scored rows differ, so a per-run mean and
 * a paired mean disagree:
 *  · #1 baseline-v1 has no case 10; #2 candidate-v2 has no case 9; #3 fast-v3 has all 12.
 *  · On the cases #1 and #2 share, `quality` is scored on all 10 baseline rows but only 7
 *    candidate rows: #2 case 6 is a task error (no scores), case 7 a `quality` scorer
 *    error, case 8 was never scored.
 *  · `quality` (higher is better): #1 case 1 = 0.4, every other #1 case 0.85; #2 case 1 =
 *    0.95, case 2 = 0.3, every other #2 case 0.9. Paired on the 7: 78.6% → 82.1%.
 *  · `policy_violations` (a count, lower is better): #2 case 2 = 2, everything else 0.
 *  · `route` (categorical): #2 case 12 routes elsewhere.
 *  · Every case takes 1000ms / $0.01 on #1, 1200ms / $0.02 on #2, 500ms / $0.005 on #3.
 */

export const QUALITY = "quality";
export const POLICY = "policy_violations";
export const ROUTE = "route";

const SCORERS = [
  { name: QUALITY, version: "1" },
  { name: POLICY, version: "1", value_type: "numeric", direction: "lower_is_better" },
  { name: ROUTE, version: "1", value_type: "categorical" },
];

/** A run's stored scorer manifest, which may carry `value_type` / `direction` beyond the
 *  `{ name, version }` its client type names. */
export const scorerManifest = (entries: object[]) => entries as RunDetail["scorers"];

export const fixtureRun = (
  id: string,
  runNumber: number,
  candidateVersion: string,
  startedAt: string,
  overrides: Partial<RunDetail> = {},
): RunDetail => ({
  id,
  evaluationId: "ev1",
  datasetId: "ds1",
  datasetVersionId: "dv1",
  runNumber,
  candidateVersion,
  environment: "dev",
  status: "completed",
  baselineRunId: null,
  caseCount: 0,
  scoredCount: 0,
  taskErrorCount: 0,
  scorerErrorCount: 0,
  erroredCount: 0,
  notScoredCount: 0,
  scorers: SCORERS,
  metadata: null,
  startedAt,
  completedAt: null,
  evaluationName: "support-routing",
  datasetName: "support-tickets",
  datasetVersionLabel: "v1",
  changeFromBaseline: null,
  errorCount: 0,
  baselineComparable: false,
  elapsedMs: null,
  comparison: {
    available: false,
    trustworthy: false,
    state: "unavailable",
    reasons: ["no_baseline"],
    baseline: null,
    scoreCellCounts: {
      improved: 0,
      regressed: 0,
      unchanged: 0,
      changed: 0,
      unpaired: 0,
      not_comparable: 0,
    },
    scorers: [],
    duration: { candidateMeanMs: null, baselineMeanMs: null, deltaMs: null, pairedCount: 0 },
  },
  ...overrides,
});

export const fixtureScore = (
  scorerName: string,
  value: number | string | null,
  error: string | null = null,
): ScoreRow => ({
  id: `${scorerName}-id`,
  scorerName,
  scorerVersion: "1",
  numericValue: typeof value === "number" ? value : null,
  boolValue: null,
  stringValue: typeof value === "string" ? value : null,
  passed: null,
  explanation: null,
  error,
});

export const fixtureResult = (
  runId: string,
  testCaseId: string,
  input: string,
  scores: ScoreRow[],
  overrides: Partial<ResultRow> = {},
): ResultRow => ({
  id: `${runId}-${testCaseId}`,
  runId,
  evaluationId: "ev1",
  testCaseId,
  traceId: null,
  input,
  expectedOutput: null,
  candidateOutput: `${runId} output`,
  baselineOutput: null,
  status: "passed",
  change: null,
  taskError: null,
  durationMs: 1000,
  cost: 0.01,
  createTime: "2026-11-01T10:00:00.000Z",
  scores,
  comparison: null,
  ...overrides,
});

const CASES = Array.from({ length: 12 }, (_, i) => i + 1);
const caseId = (n: number) => `case-${n}`;
const caseInput = (n: number) => `Ticket ${n}`;

const baselineResults = CASES.filter((n) => n !== 10).map((n) =>
  fixtureResult(
    "run-1",
    caseId(n),
    caseInput(n),
    [
      fixtureScore(QUALITY, n === 1 ? 0.4 : 0.85),
      fixtureScore(POLICY, 0),
      fixtureScore(ROUTE, "billing"),
    ],
    { durationMs: 1000, cost: 0.01 },
  ),
);

const candidateScores = (n: number): ScoreRow[] => {
  if (n === 6 || n === 8) return [];
  return [
    n === 7
      ? fixtureScore(QUALITY, null, "judge timed out")
      : fixtureScore(QUALITY, n === 1 ? 0.95 : n === 2 ? 0.3 : 0.9),
    fixtureScore(POLICY, n === 2 ? 2 : 0),
    fixtureScore(ROUTE, n === 12 ? "refunds" : "billing"),
  ];
};

const candidateResults = CASES.filter((n) => n !== 9).map((n) =>
  fixtureResult("run-2", caseId(n), caseInput(n), candidateScores(n), {
    durationMs: 1200,
    cost: 0.02,
    ...(n === 6 ? { status: "errored", taskError: "Upstream timeout" } : {}),
    ...(n === 8 ? { status: "not_scored" } : {}),
  }),
);

const fastResults = CASES.map((n) =>
  fixtureResult(
    "run-3",
    caseId(n),
    caseInput(n),
    [fixtureScore(QUALITY, 0.8), fixtureScore(POLICY, 0), fixtureScore(ROUTE, "billing")],
    { durationMs: 500, cost: 0.005 },
  ),
);

export const BASELINE_RUN = fixtureRun("run-1", 1, "baseline-v1", "2026-11-01T10:00:00.000Z");
export const CANDIDATE_RUN = fixtureRun("run-2", 2, "candidate-v2", "2026-11-02T10:00:00.000Z");
export const FAST_RUN = fixtureRun("run-3", 3, "fast-v3", "2026-11-03T10:00:00.000Z");

/** In selection order, newest first, so nothing passes by accident of input order. */
export const PAIRED_FIXTURE: RunBundle[] = [
  { run: FAST_RUN, results: fastResults },
  { run: CANDIDATE_RUN, results: candidateResults },
  { run: BASELINE_RUN, results: baselineResults },
];
