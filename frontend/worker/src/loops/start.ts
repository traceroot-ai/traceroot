/**
 * A pending run's start: every gate, then pending to running, in one
 * transaction. The project's advisory lock serializes the daily cap's count
 * with the start, so two runs of one project (different Loops, different
 * workers) cannot both read 23 of 24 and both start. The Loop's row lock means
 * a pause committed before the start is seen here, and one committed after it
 * waits for the run to be running.
 */
import { PlanType, prisma } from "@traceroot/core";
import {
  COUNTED_RUN_WHERE,
  LOOP_LIMITS,
  lockLoop,
  type LoopRunStatus,
} from "@traceroot/core/loops";

const DAY_MS = 24 * 3_600_000;

export const LOOP_PAUSED_SKIP = "Skipped: the loop was paused before this run started.";
export const LOOP_PLAN_SKIP = "Skipped: the workspace reached its loop run limit.";
export const LOOP_DAILY_CAP_SKIP = `Skipped: this project reached its limit of ${LOOP_LIMITS.runsPerProjectPerDay} loop runs in 24 hours.`;

/**
 * "skipped": a gate ended the run (it counts against nothing); "taken": the
 * run was no longer pending (another worker had it).
 */
export type LoopRunStart = "started" | "skipped" | "taken";

interface Skip {
  status: Extract<LoopRunStatus, "skipped_paused" | "skipped_blocked">;
  error: string;
}

export async function startLoopRun(run: {
  id: string;
  loopId: string;
  projectId: string;
}): Promise<LoopRunStart> {
  return prisma.$transaction(async (tx) => {
    // `$executeRaw`: pg_advisory_xact_lock returns void, which $queryRaw cannot read.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('loop_runs'), hashtext(${run.projectId}))`;
    const loop = await lockLoop(tx, run.projectId, run.loopId);
    const current = await tx.loopRun.findUnique({
      where: { id: run.id },
      select: {
        status: true,
        project: {
          select: {
            deleteTime: true,
            workspace: { select: { billingPlan: true, loopBlocked: true } },
          },
        },
      },
    });
    if (current?.status !== "pending") return "taken";

    const now = new Date();
    const { project } = current;
    let skip: Skip | null = null;
    // A Loop paused (or a project deleted) after its run was queued: the run
    // never starts. Manual runs too, as "Run now" needs an active Loop.
    if (loop?.status !== "active" || project.deleteTime !== null) {
      skip = { status: "skipped_paused", error: LOOP_PAUSED_SKIP };
    } else if (
      project.workspace.loopBlocked &&
      (project.workspace.billingPlan as PlanType) === PlanType.FREE
    ) {
      skip = { status: "skipped_blocked", error: LOOP_PLAN_SKIP };
    } else {
      const runsToday = await tx.loopRun.count({
        where: {
          projectId: run.projectId,
          createTime: { gte: new Date(now.getTime() - DAY_MS) },
          // A run that started counts before it has its session.
          OR: [{ status: "running" }, COUNTED_RUN_WHERE],
        },
      });
      if (runsToday >= LOOP_LIMITS.runsPerProjectPerDay) {
        skip = { status: "skipped_blocked", error: LOOP_DAILY_CAP_SKIP };
      }
    }

    const moved = await tx.loopRun.updateMany({
      where: { id: run.id, status: "pending" },
      data: skip
        ? { status: skip.status, error: skip.error, finishedAt: now }
        : { status: "running", startedAt: now },
    });
    if (moved.count === 0) return "taken";
    return skip ? "skipped" : "started";
  });
}
