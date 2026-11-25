import { prisma } from "@traceroot/core";

/**
 * Set a finished run's scored, task-error and scorer-error counts from the results stored
 * for it. The SDKs count only the uploads they saw acknowledged, so the counts they send
 * leave out a result stored without the SDK seeing the reply, or stored after the run
 * finished. The stored results are the record, so they win.
 *
 * Counted the way the SDKs count the results they upload:
 * - a task error is a result whose `task_error` is set;
 * - a scorer error is a score whose `error` is set: a scorer that raised, or one that
 *   returned NaN or Infinity, which the SDKs upload as an errored score;
 * - a scored case is a result with no task error and at least one score without an error.
 *
 * Does nothing while the run is running, so the results a running run reports do not each
 * lock its row; the call that finishes the run runs this.
 *
 * Every writer calls this after its own write has committed. A run never goes back to
 * running, so whichever of a result and the run's completion commits second sees the
 * other: the completion counts the result, or the result's writer finds the run finished
 * and counts again. The run row is locked while counting, so two counts of one run write
 * in turn, and the later one counts every result committed before it.
 */
export async function syncFinishedRunCounts(runId: string, projectId: string): Promise<void> {
  const run = await prisma.evaluationRun.findFirst({
    where: { id: runId, projectId },
    select: { status: true },
  });
  if (!run || run.status === "running") return;

  await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM evaluation_runs WHERE id = ${runId} FOR UPDATE`;
    const results = { runId, projectId };
    const scoredCount = await tx.evaluationResult.count({
      where: { ...results, taskError: null, scores: { some: { error: null } } },
    });
    const taskErrorCount = await tx.evaluationResult.count({
      where: { ...results, taskError: { not: null } },
    });
    const scorerErrorCount = await tx.score.count({
      where: { result: results, error: { not: null } },
    });
    await tx.evaluationRun.update({
      where: { id: runId },
      data: { scoredCount, taskErrorCount, scorerErrorCount },
    });
  });
}
