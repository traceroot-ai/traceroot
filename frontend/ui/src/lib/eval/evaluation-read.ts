import { EVAL_RUN_STATUSES, prisma, type EvalRunStatus } from "@traceroot/core";
import { clampLimit } from "@/lib/eval/dataset-read";
import type { EvalReadResult } from "@/lib/eval/read-result";

/**
 * The evaluation catalog's listing reads, inside a project the caller has ALREADY resolved.
 *
 * `get_evaluation_run` answers for one run, but a caller has no way to learn a run id
 * without listing first, so these two are what make that read reachable from a terminal or
 * a chat: the evaluations a project has, and the runs of one of them.
 *
 * Both are IDENTITY and STATUS only. No per-run counts, means, cost or duration: those are
 * aggregates over a run's results, so a page of twenty runs would be twenty aggregate
 * queries, and the run read already answers them one run at a time. A list that stays cheap
 * can be paged; a list that quietly costs a table scan per row cannot.
 *
 * Evaluations are authored catalog data, like datasets, so no retention window applies to
 * the catalog itself. The run READ still gates on retention; listing a run's identity does
 * not disclose its telemetry.
 */

export const EVALUATION_LIST_DEFAULT_LIMIT = 50;
export const EVALUATION_LIST_MAX_LIMIT = 200;

type Body = Record<string, unknown>;

/**
 * A cursor naming no row in the set being paged. Prisma treats a cursor as a position, not
 * a membership test, so a stale or foreign cursor would otherwise answer with an empty last
 * page that a client paging to completion cannot tell from the end of the data.
 */
const INVALID_CURSOR = { ok: false, status: 400, error: "Invalid cursor" } as const;

const STATUSES = new Set<string>(EVAL_RUN_STATUSES);

/** The client-facing id for each of these dataset rows, in one query rather than per row. */
async function clientDatasetIds(
  projectId: string,
  datasetIds: string[],
): Promise<Map<string, string>> {
  const unique = [...new Set(datasetIds)];
  if (unique.length === 0) return new Map();
  const rows = await prisma.dataset.findMany({
    where: { id: { in: unique }, projectId },
    select: { id: true, clientDatasetId: true },
  });
  return new Map(rows.map((d) => [d.id, d.clientDatasetId ?? d.id]));
}

/**
 * The project's evaluations, newest first, each with its run count and its latest run.
 *
 * The latest run is what makes the list answer "where does this stand?" without a second
 * call, and it is one indexed row per evaluation rather than an aggregate over results.
 */
export async function listEvaluationsPage(input: {
  projectId: string;
  limit: unknown;
  cursor: string | null;
  name: string | null;
}): Promise<EvalReadResult<Body>> {
  const { projectId, cursor } = input;
  const limit = clampLimit(input.limit, EVALUATION_LIST_DEFAULT_LIMIT, EVALUATION_LIST_MAX_LIMIT);
  const name = input.name?.trim();
  if (cursor && !(await prisma.evaluation.findFirst({ where: { id: cursor, projectId } }))) {
    return INVALID_CURSOR;
  }

  const rows = await prisma.evaluation.findMany({
    where: {
      projectId,
      ...(name ? { name: { contains: name, mode: "insensitive" as const } } : {}),
    },
    orderBy: { id: "desc" },
    take: limit + 1,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    select: {
      id: true,
      name: true,
      evaluationKey: true,
      datasetId: true,
      createTime: true,
      updateTime: true,
      _count: { select: { runs: true } },
      runs: {
        // The same two keys the runs list orders by: runs reported in one batch share a
        // timestamp, and on a tie the row id decides, so "latest" is one run, not whichever
        // the plan happened to return.
        orderBy: [{ startedAt: "desc" }, { id: "desc" }],
        take: 1,
        select: { id: true, runNumber: true, status: true, startedAt: true },
      },
    },
  });

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const datasetIdFor = await clientDatasetIds(
    projectId,
    page.map((e) => e.datasetId),
  );

  return {
    ok: true,
    body: {
      evaluations: page.map((e) => {
        const latest = e.runs[0];
        return {
          evaluation_id: e.id,
          name: e.name,
          // The SDK's own key for this evaluation: what it re-uses to report the next run.
          evaluation_key: e.evaluationKey,
          // The id a CLIENT addresses the dataset by, as every dataset read reports it.
          dataset_id: datasetIdFor.get(e.datasetId) ?? e.datasetId,
          run_count: e._count.runs,
          // Null for an evaluation nothing has run yet — an empty lineage is information,
          // not an error.
          latest_run: latest
            ? {
                evaluation_run_id: latest.id,
                run_number: latest.runNumber,
                status: latest.status,
                started_at: latest.startedAt.toISOString(),
              }
            : null,
          created_at: e.createTime.toISOString(),
          updated_at: e.updateTime.toISOString(),
        };
      }),
      // Opaque row id. Null at the end, so a client loops until null rather than counting.
      next_cursor: hasMore ? page[page.length - 1].id : null,
    },
  };
}

/**
 * A project's evaluation runs, newest first, optionally one evaluation's or one status's.
 *
 * Ordered by `started_at` with the row id as tiebreaker: runs reported in one batch share a
 * timestamp, and ties without a tiebreaker make cursor paging skip or repeat rows.
 */
export async function listEvaluationRunsPage(input: {
  projectId: string;
  limit: unknown;
  cursor: string | null;
  evaluationId: string | null;
  status: string | null;
}): Promise<EvalReadResult<Body>> {
  const { projectId, cursor } = input;
  const limit = clampLimit(input.limit, EVALUATION_LIST_DEFAULT_LIMIT, EVALUATION_LIST_MAX_LIMIT);
  const status = input.status?.trim();
  // The published enum is the gateway's; this is the backstop for a request that reaches
  // the control plane without passing it, so an unknown status is refused rather than
  // silently answered with every run.
  if (status && !STATUSES.has(status)) {
    return { ok: false, status: 400, error: "Invalid status" };
  }
  if (cursor && !(await prisma.evaluationRun.findFirst({ where: { id: cursor, projectId } }))) {
    return INVALID_CURSOR;
  }
  // Scoped to the project, so a foreign evaluation id lists nothing rather than 404ing on a
  // row the caller cannot see either way.
  const evaluationId = input.evaluationId?.trim() || null;

  const rows = await prisma.evaluationRun.findMany({
    where: {
      projectId,
      ...(evaluationId ? { evaluationId } : {}),
      ...(status ? { status } : {}),
    },
    orderBy: [{ startedAt: "desc" }, { id: "desc" }],
    take: limit + 1,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    select: {
      id: true,
      evaluationId: true,
      runNumber: true,
      candidateVersion: true,
      environment: true,
      status: true,
      datasetId: true,
      datasetVersionId: true,
      startedAt: true,
      completedAt: true,
      evaluation: { select: { name: true, evaluationKey: true } },
    },
  });

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const datasetIdFor = await clientDatasetIds(
    projectId,
    page.map((r) => r.datasetId),
  );

  return {
    ok: true,
    body: {
      runs: page.map((r) => ({
        evaluation_run_id: r.id,
        evaluation_id: r.evaluationId,
        evaluation_name: r.evaluation.name,
        evaluation_key: r.evaluation.evaluationKey,
        run_number: r.runNumber,
        candidate_version: r.candidateVersion,
        environment: r.environment,
        status: r.status as EvalRunStatus,
        dataset_id: datasetIdFor.get(r.datasetId) ?? r.datasetId,
        dataset_version_id: r.datasetVersionId,
        started_at: r.startedAt.toISOString(),
        // Null while the run is still going, as on the run read.
        completed_at: r.completedAt ? r.completedAt.toISOString() : null,
      })),
      next_cursor: hasMore ? page[page.length - 1].id : null,
    },
  };
}
