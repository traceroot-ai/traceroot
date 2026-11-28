/**
 * A pending run's start: every gate, then pending to running, in one
 * transaction. The project's advisory lock serializes the daily cap's count
 * with the start, so two runs of one project (different Loops, different
 * workers) cannot both read 23 of 24 and both start. The Loop's row lock means
 * a pause committed before the start is seen here, and one committed after it
 * waits for the run to be running. A Free workspace's plan runs are counted
 * live under a workspace lock, so runs of two of its projects cannot both read
 * 29 of 30 and both start.
 */
import { PlanType, isBillingEnabled, isLoopRunBlocked, prisma, type Prisma } from "@traceroot/core";
import {
  LOOP_LIMITS,
  countFreeLoopRunsUsed,
  countProjectLoopRunsSince,
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
            workspaceId: true,
            workspace: { select: { billingPlan: true } },
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
      await freePlanRunsUsedUp(tx, project.workspaceId, project.workspace.billingPlan as PlanType)
    ) {
      skip = { status: "skipped_blocked", error: LOOP_PLAN_SKIP };
    } else {
      // Counted from the agent's sessions, not from loop_runs: deleting a Loop
      // deletes its runs, and must not hand the project a fresh allowance.
      const runsToday = await countProjectLoopRunsSince(
        tx,
        run.projectId,
        new Date(now.getTime() - DAY_MS),
      );
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

/**
 * Whether a Free workspace has used its plan's Loop runs, counted live (the
 * hourly `loopBlocked` lags between billing passes). Paid plans, and billing
 * off, are never held and take no lock.
 */
async function freePlanRunsUsedUp(
  tx: Prisma.TransactionClient,
  workspaceId: string,
  plan: PlanType,
): Promise<boolean> {
  if (!isBillingEnabled() || plan !== PlanType.FREE) return false;
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('loop_plan_runs'), hashtext(${workspaceId}))`;
  return isLoopRunBlocked(plan, await countFreeLoopRunsUsed(tx, workspaceId));
}
