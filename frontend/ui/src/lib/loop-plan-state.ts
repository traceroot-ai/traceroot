import { PlanType, isBillingEnabled, isLoopRunBlocked, prisma } from "@traceroot/core";
import { countFreeLoopRunsUsed } from "@traceroot/core/loops";
import { isPlainObject } from "@/lib/is-plain-object";
import { isLoopsEnabled } from "@/lib/loops-enabled";

/**
 * A Free workspace's Loop plan state, counted live as Run now and the worker
 * count it: the stored `loopBlocked` and Loop meter only change on the hourly
 * billing pass, so the Loop pages and the billing card would lag the cap. Paid
 * plans, billing off and Loops off get the stored values, without a query, and
 * so does a read whose count fails: the workspace still loads, and Run now and
 * the worker still hold the cap.
 */
export async function loopPlanState(workspace: {
  id: string;
  billingPlan: string;
  loopBlocked: boolean;
  currentUsage: unknown;
}): Promise<{ loopBlocked: boolean; currentUsage: unknown }> {
  const stored = { loopBlocked: workspace.loopBlocked, currentUsage: workspace.currentUsage };
  if (!isBillingEnabled() || !isLoopsEnabled() || workspace.billingPlan !== PlanType.FREE) {
    return stored;
  }
  let runsUsed: number;
  try {
    runsUsed = await countFreeLoopRunsUsed(prisma, workspace.id);
  } catch (error) {
    console.error(`[Loops] live plan count failed for workspace ${workspace.id}:`, error);
    return stored;
  }
  const usage = isPlainObject(workspace.currentUsage) ? workspace.currentUsage : {};
  const loop = isPlainObject(usage.loop) ? usage.loop : {};
  const metered = typeof loop.runsUsed === "number" ? loop.runsUsed : 0;
  return {
    loopBlocked: isLoopRunBlocked(PlanType.FREE, runsUsed),
    currentUsage: { ...usage, loop: { ...loop, runsUsed: Math.max(metered, runsUsed) } },
  };
}
