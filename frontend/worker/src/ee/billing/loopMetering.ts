/**
 * The Loop meter: runs and token cost from the Loop turns (aIMessage rows of
 * kind "loop"), the billing source of every agent kind. A run is counted once
 * the agent replied in its turn (see REPLIED): a run whose model failed before
 * answering is not. Messages outlive the Loop (its loop_runs go with it), so
 * deleting a Loop gives back no runs.
 * Written to currentUsage.loop, which the billing tab's Loop usage card and
 * the Loop pages' plan banner read, and to loopBlocked the way detectorBlocked
 * is: Free plans are capped, paid plans are never blocked. Paid plans are
 * charged for hosted inference by the detector rule (hostedOverageUnits, in
 * usageMetering.ts).
 */
import { prisma, PlanType, isLoopRunBlocked, LOOP_RUN_QUOTAS } from "@traceroot/core";
import { aggregateMessagesForKind } from "./usageMetering.js";

export interface LoopUsage {
  runsUsed: number;
  systemTokenCost: number;
  systemInputTokens: number;
  systemOutputTokens: number;
  byModel: {
    model: string;
    provider: string;
    isByok: boolean;
    messages: number;
    inputTokens: number;
    outputTokens: number;
    cost: number;
  }[];
  /** Stripe delta tracking, as for the detector meter. */
  lastReportedUnits: number;
  lastReportedPeriodStart: string | null;
}

type MeteredLoopUsage = Omit<LoopUsage, "lastReportedUnits" | "lastReportedPeriodStart">;

export interface LoopMeter {
  usage: MeteredLoopUsage;
  /** The new loopBlocked, or undefined when it does not change. */
  loopBlocked?: boolean;
}

/**
 * The rows of a turn in which the agent replied: a tool call, or assistant
 * text. A model that fails before answering leaves only the kickoff and an
 * empty assistant row that carries the error.
 */
const REPLIED = [{ role: "tool_step" }, { role: "assistant", content: { not: "" } }];

export async function meterLoopRuns(
  workspace: { id: string; loopBlocked: boolean },
  plan: PlanType,
  periodWindow: { createTime: { gte: Date; lt: Date } },
): Promise<LoopMeter> {
  const [runSessions, agg] = await Promise.all([
    // One session per run (the worker opens a fresh one for each), and a
    // person's later turn in it is billed as RCA, not as "loop".
    prisma.aIMessage.groupBy({
      by: ["sessionId"],
      where: {
        workspaceId: workspace.id,
        kind: "loop",
        sessionId: { not: null },
        OR: REPLIED,
        ...periodWindow,
      },
    }),
    aggregateMessagesForKind(workspace.id, "loop", periodWindow),
  ]);
  const runsUsed = runSessions.length;

  const usage: MeteredLoopUsage = {
    runsUsed,
    systemTokenCost: Number(agg.systemAgg._sum.cost ?? 0),
    systemInputTokens: Number(agg.systemAgg._sum.inputTokens ?? 0),
    systemOutputTokens: Number(agg.systemAgg._sum.outputTokens ?? 0),
    byModel: [...agg.systemByModel, ...agg.byokByModel].map((row) => ({
      model: row.model ?? "unknown",
      provider: row.provider ?? "unknown",
      isByok: row.isByok ?? false,
      messages: row._count.id,
      inputTokens: row._sum.inputTokens ?? 0,
      outputTokens: row._sum.outputTokens ?? 0,
      cost: Number(row._sum.cost ?? 0),
    })),
  };

  // Free: hard cap. Paid: always unblocked (a stale flag from a Free past is cleared).
  const shouldBlock = isLoopRunBlocked(plan, runsUsed);
  if (workspace.loopBlocked === shouldBlock) return { usage };
  console.log(
    `[Billing] Workspace ${workspace.id}: ${runsUsed}/${LOOP_RUN_QUOTAS[plan].included} Loop runs, loop_blocked: ${shouldBlock}`,
  );
  return { usage, loopBlocked: shouldBlock };
}
