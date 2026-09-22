import { PlanType, prisma, type EvalRunStatus, type ReadRunResponse } from "@traceroot/core";
import type { ComparisonScorerMeta } from "@/lib/eval/comparison";
import { parseScorers } from "@/lib/eval/comparison-db";
import type { EvalReadResult } from "@/lib/eval/read-result";
import { countResultStatuses } from "@/lib/eval/result-status-counts";
import { runLink } from "@/lib/eval/run-link";
import { ScoreSummarizer, metricSummary, type SummaryItem } from "@/lib/eval/run-summary";
import { isOutsideRetention } from "@/lib/server/retention";

const RUN_SELECT = {
  id: true,
  evaluationId: true,
  projectId: true,
  runNumber: true,
  candidateVersion: true,
  environment: true,
  status: true,
  datasetId: true,
  datasetVersionId: true,
  caseCount: true,
  scoredCount: true,
  taskErrorCount: true,
  scorerErrorCount: true,
  scorers: true,
  startedAt: true,
  completedAt: true,
} as const;

/** `MetricItem` on the wire — one shape for a score and for a derived metric alike. */
type MetricItem = ReadRunResponse["scores"][number];

function metricItem(m: SummaryItem): MetricItem {
  return {
    name: m.name,
    // Server-supplied so formatting is not reinvented per client. A score is unitless:
    // a [0,1] score is a CONVENTION, not a unit, and calling it "%" would have the
    // server assert something it cannot know.
    unit: m.unit,
    direction: m.direction,
    value_type: m.valueType,
    value: m.value,
    observed_count: m.observedCount,
  };
}

/** One scorer's totals over the run, as the query in `summarizeScores` returns them. */
type ScorerTotalsRow = {
  name: string;
  sum: number | null;
  numeric: bigint | number;
  booleans: bigint | number;
  labels: bigint | number;
};

/**
 * Fold a run's scores into per-scorer means in one aggregate query, so a read costs one
 * statement however many results the run holds. The counts and stored metrics are
 * aggregated in the database the same way, and no result is ever read row by row.
 *
 * The query makes the summarizer's own pick, one row per result and scorer: the version the
 * run declared, else the highest version. It then sums each scorer's values the way
 * `readScore` reads a row: a boolean first, then a finite number, then a label. An errored
 * row is still picked, since it can be the declared version that wins, but it adds nothing;
 * a scorer only ever seen errored is still listed.
 *
 * No TEXT column is read. `error` is only tested for NULL, and per-case TEXT such as
 * `candidate_output` (up to 1 MB each) never appears.
 */
async function summarizeScores(
  runId: string,
  projectId: string,
  scorers: ComparisonScorerMeta[],
): Promise<SummaryItem[]> {
  // A later declaration of a name wins, as in the summarizer; a blank version declares none.
  const declared = [...new Map(scorers.map((s) => [s.name, s.version || null]))].map(
    ([name, version]) => ({ name, version }),
  );
  const rows = await prisma.$queryRaw<ScorerTotalsRow[]>`
    WITH declared AS (
      SELECT d.name, d.version
      FROM jsonb_to_recordset(${JSON.stringify(declared)}::jsonb) AS d(name text, version text)
    ),
    picked AS (
      SELECT DISTINCT ON (s.result_id, s.scorer_name)
        s.scorer_name,
        s.error IS NOT NULL AS errored,
        s.bool_value,
        s.numeric_value IS NOT NULL AS has_number,
        CASE WHEN s.numeric_value IN ('NaN', 'Infinity', '-Infinity') THEN NULL
             ELSE s.numeric_value END AS finite_number,
        s.string_value IS NOT NULL AS has_label
      FROM scores s
      JOIN evaluation_results r ON r.id = s.result_id
      LEFT JOIN declared d ON d.name = s.scorer_name
      WHERE r.run_id = ${runId} AND r.project_id = ${projectId}
      ORDER BY s.result_id, s.scorer_name,
        (s.scorer_version = d.version) DESC NULLS LAST,
        s.scorer_version COLLATE "C" DESC
    )
    SELECT
      scorer_name AS name,
      SUM(CASE WHEN bool_value IS NOT NULL THEN bool_value::int ELSE finite_number END)
        FILTER (WHERE NOT errored) AS sum,
      COUNT(*) FILTER (
        WHERE NOT errored AND (bool_value IS NOT NULL OR finite_number IS NOT NULL)
      ) AS numeric,
      COUNT(*) FILTER (WHERE NOT errored AND bool_value IS NOT NULL) AS booleans,
      COUNT(*) FILTER (
        WHERE NOT errored AND bool_value IS NULL AND NOT has_number AND has_label
      ) AS labels
    FROM picked
    GROUP BY scorer_name`;

  const summarizer = new ScoreSummarizer(scorers);
  for (const r of rows) {
    summarizer.addTotals(r.name, {
      sum: r.sum ?? 0,
      numeric: Number(r.numeric),
      booleans: Number(r.booleans),
      labels: Number(r.labels),
    });
  }
  return summarizer.items();
}

/**
 * Read one run's summary inside a project the caller has ALREADY resolved.
 *
 * Called by the secret-authed internal route the backend uses for every caller of the
 * public run read and for the agent, so each answers from one body with the same error
 * strings. The run is resolved inside the project, so a guessed id from another tenant
 * 404s rather than confirming it exists.
 *
 * The run's OWN summary, and nothing else: comparing two runs is a different question
 * with its own trust rules, and it is not answered here.
 *
 * SUMMARY ONLY — no per-case rows. The session-authed run detail caps results at 1000 and
 * reports `results_truncated`; this read sidesteps that entirely because its payload is
 * bounded by SCORER count, not case count. Per-case reads want real pagination and are a
 * separate endpoint.
 */
export async function readRunSummary(input: {
  projectId: string;
  runId: string;
}): Promise<EvalReadResult<ReadRunResponse>> {
  const { projectId, runId } = input;

  // The run's header only. Its results are read after the retention gate, so a refused
  // run costs one small lookup, not a read of every result it holds.
  const run = await prisma.evaluationRun.findFirst({
    where: { id: runId, projectId },
    select: {
      ...RUN_SELECT,
      evaluation: { select: { name: true, evaluationKey: true } },
    },
  });
  if (!run) return { ok: false, status: 404, error: "Evaluation run not found" };

  // Retention gate — the by-id half. A list has a window to pull forward, so it clamps
  // silently; a by-id read has none, so it refuses. That is the split the telemetry
  // surfaces make between clamp_retention_window and enforce_retention_by_time
  // (backend/rest/retention.py).
  //
  // The plan is the one on the workspace that OWNS the project, never the caller's. Both
  // callers of this read have already resolved the project — from the caller's credential,
  // or from the backend on the agent's behalf — so resolving the plan here gives the same answer
  // to both, and the internal service identity cannot inherit a wider window than the
  // project is entitled to. An unreadable or absent workspace fails closed to the most
  // restrictive plan, as the detector proxies do.
  //
  // After the 404, so a run that does not exist stays a 404 and skips the plan lookup;
  // before the dataset read and the summary, so a refusal does no work.
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { workspace: { select: { billingPlan: true } } },
  });
  const billingPlan = project?.workspace?.billingPlan || PlanType.FREE;
  if (isOutsideRetention(billingPlan, run.startedAt)) {
    return { ok: false, status: 403, error: "Data outside retention window" };
  }

  const where = { runId: run.id, projectId };
  const [byStatus, stored, scores, dataset] = await Promise.all([
    prisma.evaluationResult.groupBy({ by: ["status"], where, _count: { _all: true } }),
    prisma.evaluationResult.aggregate({
      where,
      _avg: { durationMs: true, cost: true },
      _count: { durationMs: true, cost: true },
    }),
    summarizeScores(run.id, projectId, parseScorers(run.scorers)),
    prisma.dataset.findFirst({
      where: { id: run.datasetId, projectId },
      select: { clientDatasetId: true, id: true },
    }),
  ]);

  const statusRows = byStatus.map((g) => ({ status: g.status, count: g._count._all }));
  const statusCounts = countResultStatuses(statusRows);
  // The shared fold counts only the statuses current SDKs write (errored / not_scored).
  // `passed` and `failed` stay valid on the wire for results from released SDK versions,
  // so the read counts those groups itself rather than reporting them as absent.
  const countOf = (status: string) => statusRows.find((g) => g.status === status)?.count ?? 0;

  // `satisfies` pins the body to the published contract: a field renamed or dropped here
  // fails to compile rather than silently diverging from the Zod/Pydantic/OpenAPI trio.
  const body = {
    evaluation_run_id: run.id,
    evaluation_id: run.evaluationId,
    evaluation_name: run.evaluation.name,
    evaluation_key: run.evaluation.evaluationKey,
    run_number: run.runNumber,
    candidate_version: run.candidateVersion,
    environment: run.environment,
    // The column is a free VARCHAR; the write path validates it against this exact
    // vocabulary (EvalRunStatusSchema on register/complete), so the read narrows
    // rather than re-validating a value the contract already gated on the way in.
    status: run.status as EvalRunStatus,
    started_at: run.startedAt.toISOString(),
    completed_at: run.completedAt?.toISOString() ?? null,
    dataset_id: dataset?.clientDatasetId ?? run.datasetId,
    dataset_version_id: run.datasetVersionId,
    // Built by the SAME helper the register response uses, so the two cannot describe one
    // run with two different links.
    ...runLink(projectId, run.id),
    // The observed population: every result this run reported, a different fact from the
    // run's DECLARED case_count. Each mean below carries its own `observed_count`, because a
    // scorer that errored on some cases averaged over fewer than this.
    result_count: statusRows.reduce((n, g) => n + g.count, 0),
    scored_count: run.scoredCount,
    task_error_count: run.taskErrorCount,
    scorer_error_count: run.scorerErrorCount,
    passed_count: countOf("passed"),
    failed_count: countOf("failed"),
    errored_count: statusCounts.erroredCount,
    not_scored_count: statusCounts.notScoredCount,
    // Two blocks, one item shape. They differ in PROVENANCE — a score is what a scorer
    // reported, a metric is what the platform derived from the trace — which stops being
    // answerable the moment someone names a scorer "cost".
    scores: scores.map(metricItem),
    metrics: [
      metricSummary("duration", stored._avg.durationMs, stored._count.durationMs),
      metricSummary("cost", stored._avg.cost, stored._count.cost),
    ].map(metricItem),
  } satisfies ReadRunResponse;

  return { ok: true, body };
}
