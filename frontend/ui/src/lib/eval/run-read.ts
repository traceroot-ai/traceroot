import { PlanType, prisma, type EvalRunStatus, type ReadRunResponse } from "@traceroot/core";
import { parseScorers } from "@/lib/eval/comparison-db";
import type { EvalReadResult } from "@/lib/eval/read-result";
import { countResultStatuses } from "@/lib/eval/result-status-counts";
import { runLink } from "@/lib/eval/run-link";
import { summarizeRun, type SummaryItem } from "@/lib/eval/run-summary";
import { isOutsideRetention } from "@/lib/server/retention";

// The columns the SUMMARY needs, and nothing else.
//
// No TEXT column is selected. `candidateOutput` in particular is up to 1 MB per case, and
// reading it here would mean on the order of a gigabyte of Postgres reads for a 5,000-case
// run, to produce a few dozen floats. Input, expected and baseline output stay out too.
const SUMMARY_RESULT_SELECT = {
  status: true,
  durationMs: true,
  cost: true,
  scores: {
    select: {
      scorerName: true,
      scorerVersion: true,
      numericValue: true,
      boolValue: true,
      stringValue: true,
      error: true,
    },
  },
} as const;

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

  const run = await prisma.evaluationRun.findFirst({
    where: { id: runId, projectId },
    select: {
      ...RUN_SELECT,
      evaluation: { select: { name: true, evaluationKey: true } },
      results: { select: SUMMARY_RESULT_SELECT },
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

  const summary = summarizeRun(parseScorers(run.scorers), run.results);

  const statusCounts = countResultStatuses(run.results.map((r) => ({ status: r.status })));
  // The shared fold counts only the statuses current SDKs write (errored / not_scored).
  // `passed` and `failed` stay valid on the wire for results from released SDK versions,
  // so the read counts those rows itself rather than reporting them as absent.
  const passedCount = run.results.filter((r) => r.status === "passed").length;
  const failedCount = run.results.filter((r) => r.status === "failed").length;
  const dataset = await prisma.dataset.findFirst({
    where: { id: run.datasetId, projectId },
    select: { clientDatasetId: true, id: true },
  });

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
    result_count: run.results.length,
    scored_count: run.scoredCount,
    task_error_count: run.taskErrorCount,
    scorer_error_count: run.scorerErrorCount,
    passed_count: passedCount,
    failed_count: failedCount,
    errored_count: statusCounts.erroredCount,
    not_scored_count: statusCounts.notScoredCount,
    // Two blocks, one item shape. They differ in PROVENANCE — a score is what a scorer
    // reported, a metric is what the platform derived from the trace — which stops being
    // answerable the moment someone names a scorer "cost".
    scores: summary.scores.map(metricItem),
    metrics: summary.metrics.map(metricItem),
  } satisfies ReadRunResponse;

  return { ok: true, body };
}
