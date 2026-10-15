import {
  prisma,
  PlanType,
  isIngestionBlocked,
  isDetectorRunBlocked,
  type Prisma,
} from "@traceroot/core";
import type { getWorkspaceUsageDetails } from "./clickhouse.js";

type Usage = Awaited<ReturnType<typeof getWorkspaceUsageDetails>>;

export type WorkspaceUsageUpdate = {
  currentUsage: Prisma.InputJsonObject;
  aiBlocked?: boolean;
  rcaBlocked?: boolean;
};

function count(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

/** Commit the observed lifetime floor and its blocking flags together.
 * The row lock prevents an older, overlapping billing job from lowering usage.
 * External usage queries and Stripe calls must stay outside this transaction.
 */
export async function persistWorkspaceUsage(
  workspaceId: string,
  plan: PlanType,
  measured: Usage,
  update: WorkspaceUsageUpdate,
): Promise<Usage | null> {
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM workspaces WHERE id = ${workspaceId} FOR UPDATE`;
    const workspace = await tx.workspace.findUnique({
      where: { id: workspaceId },
      select: { billingPlan: true, freeLifetimeUsage: true },
    });
    // A plan change while querying usage invalidates this job's billing window.
    if (!workspace || workspace.billingPlan !== plan) return null;

    let usage = measured;
    if (plan === PlanType.FREE) {
      const saved = workspace.freeLifetimeUsage as Partial<Usage> | null;
      const bySource = { ...measured.bySource };
      for (const source of ["user", "detector", "agent"] as const) {
        bySource[source] = {
          traces: Math.max(
            measured.bySource[source].traces,
            count(saved?.bySource?.[source]?.traces),
          ),
          spans: Math.max(measured.bySource[source].spans, count(saved?.bySource?.[source]?.spans)),
        };
      }
      usage = {
        traces: Object.values(bySource).reduce((sum, bucket) => sum + bucket.traces, 0),
        spans: Object.values(bySource).reduce((sum, bucket) => sum + bucket.spans, 0),
        detectorRuns: Math.max(measured.detectorRuns, count(saved?.detectorRuns)),
        bySource,
      };
    }

    await tx.workspace.update({
      where: { id: workspaceId },
      data: {
        ...update,
        ...(plan === PlanType.FREE ? { freeLifetimeUsage: usage } : {}),
        currentUsage: {
          ...update.currentUsage,
          traces: usage.traces,
          spans: usage.spans,
          bySource: usage.bySource,
          detector: {
            ...(update.currentUsage.detector as Prisma.InputJsonObject),
            scansRun: usage.detectorRuns,
          },
        },
        ingestionBlocked: isIngestionBlocked(plan, usage.traces + usage.spans),
        detectorBlocked: isDetectorRunBlocked(plan, usage.detectorRuns),
      },
    });
    return usage;
  });
}
