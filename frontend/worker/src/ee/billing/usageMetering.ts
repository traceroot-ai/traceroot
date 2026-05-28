/**
 * Billing Worker
 *
 * Runs hourly to process all workspaces:
 * 1. Query usage (traces + spans) from ClickHouse ONCE per workspace
 * 2. Count AI runs (assistant messages) from PostgreSQL
 * 3. Update currentUsage JSON (for billing page display)
 * 4. Update ingestionBlocked / aiBlocked flags
 * 5. Report overage to Stripe (paid plans only)
 *
 * AI Run Billing:
 * - Free plan: hard cap at 30 runs/month (blocked when reached)
 * - Starter/Pro: first 100 runs free, then $10/100 runs + 1.05x system model token cost
 * - BYOK runs: only run fee, no token markup (user pays their own API)
 * - Stripe receives units at $0.01 each; TraceRoot calculates the unit count
 */

import Stripe from "stripe";
import {
  prisma,
  USAGE_CONFIG,
  PlanType,
  isAiRunBlocked,
  isRcaRunBlocked,
  isDetectorRunBlocked,
  DETECTOR_HOSTED_LLM_FREE_THRESHOLD,
  AI_RUN_QUOTAS,
  RCA_RUN_QUOTAS,
  DETECTOR_RUN_QUOTAS,
  EVENT_QUOTAS,
} from "@traceroot/core";
import { getWorkspaceUsageDetails } from "./clickhouse.js";
import crypto from "crypto";
import { createRedisConnection, createDetectorRunQueue } from "../../queues/detector-run-queue.js";

let stripe: Stripe | null = null;

function getStripe(): Stripe {
  if (!stripe) {
    const secretKey = process.env.STRIPE_SECRET_KEY;
    if (!secretKey) {
      throw new Error("STRIPE_SECRET_KEY is not configured");
    }
    stripe = new Stripe(secretKey);
  }
  return stripe;
}

/**
 * Main billing job - processes all workspaces in a single pass.
 */
export async function runBillingJob(): Promise<void> {
  console.log("[Billing] Starting billing job...");

  try {
    const workspaces = await prisma.workspace.findMany({
      include: {
        projects: {
          where: { deleteTime: null },
          select: { id: true },
        },
      },
    });

    console.log(`[Billing] Processing ${workspaces.length} workspaces`);

    const now = new Date();
    const allTimeStart = new Date(0);

    let stripeClient: Stripe | null = null;
    try {
      stripeClient = getStripe();
    } catch {
      console.warn("[Billing] Stripe not configured, skipping Stripe updates");
    }

    for (const workspace of workspaces) {
      try {
        await processWorkspace(workspace, {
          now,
          allTimeStart,
          stripeClient,
        });
      } catch (error) {
        console.error(`[Billing] Error processing workspace ${workspace.id}:`, error);
      }
    }

    console.log("[Billing] Job completed successfully");
  } catch (error) {
    console.error("[Billing] Job failed:", error);
    throw error;
  }
}

async function processWorkspace(
  workspace: {
    id: string;
    billingPlan: string;
    billingCustomerId: string | null;
    billingSubscriptionId: string | null;
    billingPeriodStart: Date | null;
    billingPeriodEnd: Date | null;
    ingestionBlocked: boolean;
    aiBlocked: boolean;
    rcaBlocked: boolean;
    detectorBlocked: boolean;
    currentUsage: any;
    projects: { id: string }[];
  },
  ctx: {
    now: Date;
    allTimeStart: Date;
    stripeClient: Stripe | null;
  },
): Promise<void> {
  const projectIds = workspace.projects.map((p) => p.id);
  const plan = workspace.billingPlan as PlanType;
  const isFreePlan = plan === PlanType.FREE;

  // =========================================================================
  // 1. Query event usage (traces + spans + detector runs) from ClickHouse
  // =========================================================================
  let usage: { traces: number; spans: number; detectorRuns: number };
  if (projectIds.length === 0) {
    usage = { traces: 0, spans: 0, detectorRuns: 0 };
  } else {
    // Free plan: total usage (all time)
    // Paid plans: usage within current billing period (from Stripe webhook)
    let start: Date;
    let end: Date;

    if (isFreePlan) {
      start = ctx.allTimeStart;
      end = ctx.now;
    } else if (workspace.billingPeriodStart && workspace.billingPeriodEnd) {
      // Use billing period dates from Stripe (updated via webhook each month)
      start = workspace.billingPeriodStart;
      end = workspace.billingPeriodEnd;
    } else {
      // Fallback to calendar month if no billing period set
      start = new Date(ctx.now.getFullYear(), ctx.now.getMonth(), 1);
      end = new Date(ctx.now.getFullYear(), ctx.now.getMonth() + 1, 1);
    }

    usage = await getWorkspaceUsageDetails({
      projectIds,
      start,
      end,
    });
  }

  const totalEvents = usage.traces + usage.spans;

  // =========================================================================
  // 2. Query AI usage from PostgreSQL
  // =========================================================================
  const aiPeriodStart = isFreePlan
    ? ctx.allTimeStart
    : (workspace.billingPeriodStart ?? new Date(ctx.now.getFullYear(), ctx.now.getMonth(), 1));
  const aiPeriodEnd = isFreePlan
    ? ctx.now
    : (workspace.billingPeriodEnd ?? new Date(ctx.now.getFullYear(), ctx.now.getMonth() + 1, 1));

  // =========================================================================
  // 2a-2d. Aggregate aIMessage rows by kind for billing + usage display.
  //
  // Three categorical sources flow into the same table:
  //   kind = "chat"     — user-initiated chat (and manual triage / issue-gen)
  //   kind = "rca"      — auto-RCA agent turns (system-initiated)
  //   kind = "detector" — single-shot detector LLM scans
  //
  // `aggregateMessagesForKind` does the per-kind heavy lifting; only the
  // chat block reads `runsUsedCount` + byokAgg (the others don't need them).
  // =========================================================================

  const periodWindow = { createTime: { gte: aiPeriodStart, lt: aiPeriodEnd } };

  const [chatAgg, rcaAgg, detectorAgg, rcaRunsUsed] = await Promise.all([
    aggregateMessagesForKind(workspace.id, "chat", periodWindow),
    aggregateMessagesForKind(workspace.id, "rca", periodWindow),
    aggregateMessagesForKind(workspace.id, "detector", periodWindow),
    prisma.detectorRca.count({
      where: { project: { workspaceId: workspace.id }, ...periodWindow },
    }),
  ]);

  const runsUsed = chatAgg.runsUsedCount;
  const systemAgg = chatAgg.systemAgg;
  const byokAgg = chatAgg.byokAgg;
  const byModel = [...chatAgg.systemByModel, ...chatAgg.byokByModel];
  const systemCost = Number(systemAgg._sum.cost ?? 0);

  const rcaSystemTokenCost = Number(rcaAgg.systemAgg._sum.cost ?? 0);
  const rcaSystemInputTokens = Number(rcaAgg.systemAgg._sum.inputTokens ?? 0);
  const rcaSystemOutputTokens = Number(rcaAgg.systemAgg._sum.outputTokens ?? 0);
  const rcaByModel = [...rcaAgg.systemByModel, ...rcaAgg.byokByModel];

  const detectorSystemTokenCost = Number(detectorAgg.systemAgg._sum.cost ?? 0);
  const detectorSystemInputTokens = Number(detectorAgg.systemAgg._sum.inputTokens ?? 0);
  const detectorSystemOutputTokens = Number(detectorAgg.systemAgg._sum.outputTokens ?? 0);
  const detectorByModel = [...detectorAgg.systemByModel, ...detectorAgg.byokByModel];

  // =========================================================================
  // 3. Build update data
  // =========================================================================
  // Preserve detector cost fields written per-scan by the detector worker.
  // (scansRun comes from ClickHouse on every cron run — no need to preserve.)
  const previousDetector =
    ((workspace.currentUsage as any)?.detector as
      | {
          systemTokenCost?: number;
          systemInputTokens?: number;
          systemOutputTokens?: number;
          lastReportedUnits?: number;
          lastReportedPeriodStart?: string | null;
        }
      | undefined) ?? {};

  const updateData: {
    currentUsage: object;
    ingestionBlocked?: boolean;
    aiBlocked?: boolean;
    rcaBlocked?: boolean;
    detectorBlocked?: boolean;
  } = {
    currentUsage: {
      traces: usage.traces,
      spans: usage.spans,
      tokens: 0,
      updatedAt: ctx.now.toISOString(),
      ai: {
        runsUsed,
        systemUsage: {
          messages: systemAgg._count.id,
          inputTokens: systemAgg._sum.inputTokens ?? 0,
          outputTokens: systemAgg._sum.outputTokens ?? 0,
          cost: systemCost,
        },
        byokUsage: {
          messages: byokAgg._count.id,
          inputTokens: byokAgg._sum.inputTokens ?? 0,
          outputTokens: byokAgg._sum.outputTokens ?? 0,
          cost: Number(byokAgg._sum.cost ?? 0),
        },
        byModel: byModel.map((row) => ({
          model: row.model ?? "unknown",
          provider: row.provider ?? "unknown",
          isByok: row.isByok ?? false,
          messages: row._count.id,
          inputTokens: row._sum.inputTokens ?? 0,
          outputTokens: row._sum.outputTokens ?? 0,
          cost: Number(row._sum.cost ?? 0),
        })),
      },
      rca: {
        runsUsed: rcaRunsUsed,
        systemTokenCost: rcaSystemTokenCost,
        systemInputTokens: rcaSystemInputTokens,
        systemOutputTokens: rcaSystemOutputTokens,
        byModel: rcaByModel.map((row) => ({
          model: row.model ?? "unknown",
          provider: row.provider ?? "unknown",
          isByok: row.isByok ?? false,
          messages: row._count.id,
          inputTokens: row._sum.inputTokens ?? 0,
          outputTokens: row._sum.outputTokens ?? 0,
          cost: Number(row._sum.cost ?? 0),
        })),
        lastReportedUnits: 0,
        lastReportedPeriodStart: null as string | null,
      },
      detector: {
        // scansRun = canonical count from ClickHouse `detector_runs`.
        // Cost + tokens = aIMessage rows tagged kind="detector" (system source).
        scansRun: usage.detectorRuns,
        systemTokenCost: detectorSystemTokenCost,
        systemInputTokens: detectorSystemInputTokens,
        systemOutputTokens: detectorSystemOutputTokens,
        byModel: detectorByModel.map((row) => ({
          model: row.model ?? "unknown",
          provider: row.provider ?? "unknown",
          isByok: row.isByok ?? false,
          messages: row._count.id,
          inputTokens: row._sum.inputTokens ?? 0,
          outputTokens: row._sum.outputTokens ?? 0,
          cost: Number(row._sum.cost ?? 0),
        })),
        lastReportedUnits: previousDetector.lastReportedUnits ?? 0,
        lastReportedPeriodStart: previousDetector.lastReportedPeriodStart ?? null,
      },
    },
  };

  // =========================================================================
  // 4. Update blocking flags
  // =========================================================================

  // 4a. Event ingestion blocking (free plan only)
  if (isFreePlan) {
    const shouldBeBlocked = totalEvents >= USAGE_CONFIG.includedUnits;
    if (workspace.ingestionBlocked !== shouldBeBlocked) {
      updateData.ingestionBlocked = shouldBeBlocked;
      console.log(
        `[Billing] Workspace ${workspace.id}: ${totalEvents}/${USAGE_CONFIG.includedUnits} events, blocked: ${shouldBeBlocked}`,
      );
    }
  }

  // 4b. AI run blocking
  if (isFreePlan) {
    // Free plan: hard cap based on run count
    const shouldBlockAi = isAiRunBlocked(plan, runsUsed);
    if (workspace.aiBlocked !== shouldBlockAi) {
      updateData.aiBlocked = shouldBlockAi;
      console.log(
        `[Billing] Workspace ${workspace.id}: ${runsUsed}/${AI_RUN_QUOTAS[plan].included} AI runs, ai_blocked: ${shouldBlockAi}`,
      );
    }
  }

  // 4c. Paid plans: always unblock AI (overage is billed, not blocked)
  if (!isFreePlan && workspace.aiBlocked) {
    updateData.aiBlocked = false;
    console.log(`[Billing] Workspace ${workspace.id}: unblocking AI (paid plan)`);
  }

  // 4c-bis. RCA blocking — Free plan only, 30-run hard cap. Mirrors AI at 4b.
  // detectorBlocked alone does NOT cap RCA: the Free RCA quota (30) is lower
  // than the Free detector-scan cap (100), so a workspace can produce 30+
  // findings before hitting the detector cap, each triggering an RCA.
  if (isFreePlan) {
    const shouldBlockRca = isRcaRunBlocked(plan, rcaRunsUsed);
    if (workspace.rcaBlocked !== shouldBlockRca) {
      updateData.rcaBlocked = shouldBlockRca;
      console.log(
        `[Billing] Workspace ${workspace.id}: ${rcaRunsUsed}/${RCA_RUN_QUOTAS[plan].included} RCA runs, rca_blocked: ${shouldBlockRca}`,
      );
    }
  }

  // 4c-ter. Paid plans: always unblock RCA (overage is billed, not blocked)
  if (!isFreePlan && workspace.rcaBlocked) {
    updateData.rcaBlocked = false;
    console.log(`[Billing] Workspace ${workspace.id}: unblocking RCA (paid plan)`);
  }

  // 4d. Detector blocking — Free plan only, 100-scan hard cap (any source).
  // Count comes from the ClickHouse `detector_runs` aggregate we just fetched
  // (same source as traces/spans). Mirrors the AI-runs hard-cap pattern at 4b.
  if (isFreePlan) {
    const shouldBlockDetector = isDetectorRunBlocked(plan, usage.detectorRuns);
    if (workspace.detectorBlocked !== shouldBlockDetector) {
      updateData.detectorBlocked = shouldBlockDetector;
      console.log(
        `[Billing] Workspace ${workspace.id}: ${usage.detectorRuns}/${DETECTOR_RUN_QUOTAS[plan].included} detector scans, detector_blocked: ${shouldBlockDetector}`,
      );
    }
  }

  // 4e. Paid plans: always unblock detector
  if (!isFreePlan && workspace.detectorBlocked) {
    updateData.detectorBlocked = false;
    console.log(`[Billing] Workspace ${workspace.id}: unblocking detector (paid plan)`);
  }

  // =========================================================================
  // 5. Stripe metering (paid plans only)
  // =========================================================================
  console.log(
    `[Billing] Stripe check: isFreePlan=${isFreePlan}, subscriptionId=${!!workspace.billingSubscriptionId}, customerId=${!!workspace.billingCustomerId}, stripeClient=${!!ctx.stripeClient}`,
  );
  if (
    !isFreePlan &&
    workspace.billingSubscriptionId &&
    workspace.billingCustomerId &&
    ctx.stripeClient
  ) {
    // 5a. Update Stripe subscription quantity for event blocks (base + overage combined).
    // Enterprise is contact-sales only — no Stripe subscription, skip.
    // Reports total 50k blocks, minimum = included blocks (e.g. 3 for starter = 150k).
    // Stripe tiered graduated price handles the math:
    //   Tier 1: 0-3 blocks → $30 flat fee (base plan cost)
    //   Tier 2: 4+ blocks  → $4/unit     (overage at $4 per 50k block)
    if (plan !== PlanType.ENTERPRISE) {
      const includedEvents = EVENT_QUOTAS[plan].included;
      const includedBlocks = includedEvents / 50_000;
      const totalEventBlocks = Math.max(includedBlocks, Math.ceil(totalEvents / 50_000));
      await updateStripeQuantity(
        workspace.billingSubscriptionId,
        totalEventBlocks,
        ctx.stripeClient,
      );
    }

    // 5b. Report AI run overage to Stripe
    const includedRuns = AI_RUN_QUOTAS[plan].included;
    const overageRuns = Math.max(0, runsUsed - includedRuns);

    // Calculate total billable units:
    // - Run overage: $10 per 100 runs, charged in blocks of 100 (rounded up)
    //   e.g. 5 overage runs = 1 block = $10; 105 overage runs = 2 blocks = $20
    //   1 block = $10 = 1000 units @ $0.01/unit
    // - System model token cost on overage runs: 1.05x markup, converted to $0.01 units (granular)
    let totalBillableUnits = 0;
    let overageSystemCost = 0;

    if (overageRuns > 0) {
      const overageBlocks = Math.ceil(overageRuns / 100);
      const runOverageUnits = overageBlocks * 1000;

      // Get system model token cost for runs beyond the included quota
      overageSystemCost = await getOverageSystemModelCost(
        workspace.id,
        includedRuns,
        aiPeriodStart,
        aiPeriodEnd,
      );
      const tokenMarkupUnits = Math.round(overageSystemCost * 1.05 * 100);

      totalBillableUnits = runOverageUnits + tokenMarkupUnits;
    }

    // Delta calculation: only report the increase since last worker run
    // Reset tracking when billing period changes (prevents negative delta after period rollover)
    const previousUsage = workspace.currentUsage as any;
    const prevPeriodStart = previousUsage?.ai?.lastReportedPeriodStart ?? null;
    const currentPeriodStart = workspace.billingPeriodStart?.toISOString() ?? null;
    const lastReportedUnits =
      prevPeriodStart === currentPeriodStart ? (previousUsage?.ai?.lastReportedUnits ?? 0) : 0;
    const deltaUnits = totalBillableUnits - lastReportedUnits;

    console.log(
      `[Billing] AI run metering: runsUsed=${runsUsed}, included=${includedRuns}, overage=${overageRuns}, ` +
        `overageSystemCost=$${overageSystemCost.toFixed(4)}, totalUnits=${totalBillableUnits}, ` +
        `lastReported=${lastReportedUnits}, delta=${deltaUnits}`,
    );

    if (deltaUnits > 0) {
      const reported = await reportAiRunOverageToStripe(
        workspace.id,
        workspace.billingCustomerId!,
        deltaUnits,
        ctx.stripeClient,
      );
      if (reported) {
        (updateData.currentUsage as any).ai.lastReportedUnits = totalBillableUnits;
        (updateData.currentUsage as any).ai.lastReportedPeriodStart = currentPeriodStart;
      }
    } else {
      // Preserve last reported values
      (updateData.currentUsage as any).ai.lastReportedUnits = lastReportedUnits;
      (updateData.currentUsage as any).ai.lastReportedPeriodStart = currentPeriodStart;
    }

    // 5c. Report RCA run overage to Stripe (separate meter / Stripe product)
    const includedRcaRuns = RCA_RUN_QUOTAS[plan].included;
    const overageRcaRuns = Math.max(0, rcaRunsUsed - includedRcaRuns);

    let totalRcaBillableUnits = 0;
    if (overageRcaRuns > 0) {
      const rcaOverageBlocks = Math.ceil(overageRcaRuns / 100);
      const rcaRunOverageUnits = rcaOverageBlocks * 1000;
      // 1.05x markup applied ONLY to the overage portion of token cost.
      // Proportional allocation by run count: same shape as detector's
      // (overageScans / scansRun), and matches chat's getOverageSystemModelCost()
      // behavior. Avoids overbilling customers whose included runs already
      // accrued most of the period's inference cost.
      // BYOK turns are excluded upstream by the kind="rca" isByok=false filter.
      const rcaOverageTokenCost =
        rcaRunsUsed > 0 ? rcaSystemTokenCost * (overageRcaRuns / rcaRunsUsed) : 0;
      const rcaTokenMarkupUnits = Math.round(rcaOverageTokenCost * 1.05 * 100);
      totalRcaBillableUnits = rcaRunOverageUnits + rcaTokenMarkupUnits;
    }

    const prevRcaPeriodStart = previousUsage?.rca?.lastReportedPeriodStart ?? null;
    const lastReportedRcaUnits =
      prevRcaPeriodStart === currentPeriodStart ? (previousUsage?.rca?.lastReportedUnits ?? 0) : 0;
    const deltaRcaUnits = totalRcaBillableUnits - lastReportedRcaUnits;

    console.log(
      `[Billing] RCA run metering: runsUsed=${rcaRunsUsed}, included=${includedRcaRuns}, overage=${overageRcaRuns}, ` +
        `systemTokenCost=$${rcaSystemTokenCost.toFixed(4)}, totalUnits=${totalRcaBillableUnits}, ` +
        `lastReported=${lastReportedRcaUnits}, delta=${deltaRcaUnits}`,
    );

    if (deltaRcaUnits > 0) {
      const reported = await reportRcaRunOverageToStripe(
        workspace.id,
        workspace.billingCustomerId!,
        deltaRcaUnits,
        ctx.stripeClient,
      );
      if (reported) {
        (updateData.currentUsage as any).rca.lastReportedUnits = totalRcaBillableUnits;
        (updateData.currentUsage as any).rca.lastReportedPeriodStart = currentPeriodStart;
      } else {
        (updateData.currentUsage as any).rca.lastReportedUnits = lastReportedRcaUnits;
        (updateData.currentUsage as any).rca.lastReportedPeriodStart = currentPeriodStart;
      }
    } else {
      (updateData.currentUsage as any).rca.lastReportedUnits = lastReportedRcaUnits;
      (updateData.currentUsage as any).rca.lastReportedPeriodStart = currentPeriodStart;
    }

    // 5d. Report managed detector inference token usage (1.05× pass-through).
    //
    // Paid plans inherit Free's "first 100 detector scans/month at $0" — we
    // absorb that hosted-LLM cost so upgrading from Free never *removes* the
    // 100-free benefit. Beyond the threshold, the OVERAGE portion of the
    // hosted-LLM cost is billed at 1.05× passthrough.
    //
    // Proportional split: we don't have per-scan cost in ClickHouse today, so
    // we apportion the period's total cost by scan count (overage / total).
    // Approximation is fine — scans within a single detector have similar cost.
    // BYOK detectors contribute 0 to systemTokenCost (we filter by isByok=false above).
    const detectorSystemCost = detectorSystemTokenCost;
    const detectorOverageScans = Math.max(
      0,
      usage.detectorRuns - DETECTOR_HOSTED_LLM_FREE_THRESHOLD,
    );
    const detectorBillableCost =
      usage.detectorRuns > 0 ? detectorSystemCost * (detectorOverageScans / usage.detectorRuns) : 0;
    const detectorTotalUnits = Math.round(detectorBillableCost * 1.05 * 100);

    const prevDetectorPeriodStart = previousDetector.lastReportedPeriodStart ?? null;
    const detectorLastReportedUnits =
      prevDetectorPeriodStart === currentPeriodStart
        ? (previousDetector.lastReportedUnits ?? 0)
        : 0;
    const detectorDeltaUnits = detectorTotalUnits - detectorLastReportedUnits;

    console.log(
      `[Billing] Detector token metering: scansRun=${usage.detectorRuns}, ` +
        `included=${DETECTOR_HOSTED_LLM_FREE_THRESHOLD}, overageScans=${detectorOverageScans}, ` +
        `totalCost=$${detectorSystemCost.toFixed(4)}, billableCost=$${detectorBillableCost.toFixed(4)}, ` +
        `totalUnits=${detectorTotalUnits}, lastReported=${detectorLastReportedUnits}, delta=${detectorDeltaUnits}`,
    );

    if (detectorDeltaUnits > 0) {
      const reported = await reportDetectorOverageToStripe(
        workspace.id,
        workspace.billingCustomerId!,
        detectorDeltaUnits,
        ctx.stripeClient,
      );
      if (reported) {
        (updateData.currentUsage as any).detector.lastReportedUnits = detectorTotalUnits;
        (updateData.currentUsage as any).detector.lastReportedPeriodStart = currentPeriodStart;
      }
    } else {
      (updateData.currentUsage as any).detector.lastReportedUnits = detectorLastReportedUnits;
      (updateData.currentUsage as any).detector.lastReportedPeriodStart = currentPeriodStart;
    }
  }

  // =========================================================================
  // 6. Write to database
  // =========================================================================
  await prisma.workspace.update({
    where: { id: workspace.id },
    data: updateData,
  });

  // =========================================================================
  // 7. Budget alert reconciliation (safety net for Redis data loss)
  //
  // The primary budget alert path is event-driven in the Python ingest
  // worker (Redis INCRBYFLOAT per batch). This hourly reconciliation
  // catches Redis crashes/evictions by re-checking authoritative
  // ClickHouse data against configured budget thresholds.
  // =========================================================================
  try {
    await reconcileBudgetAlerts(workspace.id, projectIds);
  } catch (e) {
    console.error(`[Billing] Budget reconciliation failed for workspace ${workspace.id}:`, e);
  }

  console.log(
    `[Billing] Workspace ${workspace.id} (${workspace.billingPlan}): ` +
      `${usage.traces} traces, ${usage.spans} spans | ` +
      `AI runs: ${runsUsed} | ` +
      `system: ${systemAgg._count.id} msgs ($${systemCost.toFixed(4)}) | ` +
      `byok: ${byokAgg._count.id} msgs`,
  );
}

type MessageKind = "chat" | "rca" | "detector";

/**
 * Aggregate `aIMessage` rows for one `kind` over a billing window. Returns:
 *   - runsUsedCount: total assistant rows (chat uses this for run-count meter;
 *     rca/detector get their canonical counts from elsewhere)
 *   - systemAgg / byokAgg: cost + token sums split by inference source
 *   - systemByModel / byokByModel: per-(model, provider) breakdowns for UI
 *
 * `inputTokens: { not: null }` filters out incomplete writes; rows with null
 * tokens have null cost too, so this is a no-op for cost sums.
 */
async function aggregateMessagesForKind(
  workspaceId: string,
  kind: MessageKind,
  periodWindow: { createTime: { gte: Date; lt: Date } },
) {
  const baseWhere = { workspaceId, kind, role: "assistant", ...periodWindow };
  const systemWhere = { ...baseWhere, isByok: false, inputTokens: { not: null } };
  const byokWhere = { ...baseWhere, isByok: true, inputTokens: { not: null } };

  const [runsUsedCount, systemAgg, byokAgg, systemByModel, byokByModel] = await Promise.all([
    prisma.aIMessage.count({ where: baseWhere }),
    prisma.aIMessage.aggregate({
      where: systemWhere,
      _count: { id: true },
      _sum: { inputTokens: true, outputTokens: true, cost: true },
    }),
    prisma.aIMessage.aggregate({
      where: byokWhere,
      _count: { id: true },
      _sum: { inputTokens: true, outputTokens: true, cost: true },
    }),
    prisma.aIMessage.groupBy({
      by: ["model", "provider", "isByok"],
      where: systemWhere,
      _count: { id: true },
      _sum: { inputTokens: true, outputTokens: true, cost: true },
    }),
    prisma.aIMessage.groupBy({
      by: ["model", "provider", "isByok"],
      where: byokWhere,
      _count: { id: true },
      _sum: { inputTokens: true, outputTokens: true, cost: true },
    }),
  ]);

  return { runsUsedCount, systemAgg, byokAgg, systemByModel, byokByModel };
}

/**
 * Get the total system model token cost for AI runs beyond the included quota.
 *
 * Two-step approach to avoid loading all overage messages into memory:
 * 1. Find the cutoff timestamp (createTime of the first overage message)
 * 2. Aggregate system model cost from that timestamp onward
 */
async function getOverageSystemModelCost(
  workspaceId: string,
  includedRuns: number,
  start: Date,
  end: Date,
): Promise<number> {
  // Step 1: Find the cutoff timestamp — the createTime of the first chat
  // message after the included quota (e.g., the 101st message for Starter/Pro).
  // kind="chat" so RCA/detector turns living in the same table don't shift
  // the cutoff or inflate the cost sum.
  const cutoff = await prisma.aIMessage.findMany({
    where: {
      workspaceId,
      kind: "chat",
      role: "assistant",
      createTime: { gte: start, lt: end },
    },
    orderBy: { createTime: "asc" },
    skip: includedRuns,
    take: 1,
    select: { createTime: true },
  });

  if (cutoff.length === 0) return 0;

  // Step 2: Aggregate system model cost from the cutoff onward (DB-side sum)
  const agg = await prisma.aIMessage.aggregate({
    where: {
      workspaceId,
      kind: "chat",
      role: "assistant",
      isByok: false,
      createTime: { gte: cutoff[0].createTime, lt: end },
    },
    _sum: { cost: true },
  });

  return Number(agg._sum.cost ?? 0);
}

async function updateStripeQuantity(
  subscriptionId: string,
  quantity: number,
  stripeClient: Stripe,
): Promise<void> {
  try {
    const subscription = await stripeClient.subscriptions.retrieve(subscriptionId);
    // Find the plan item (not the metered usage items — AI runs, RCA runs, detector usage)
    const aiUsagePriceId = process.env.STRIPE_PRICE_ID_AI_USAGE;
    const rcaUsagePriceId = process.env.STRIPE_PRICE_ID_RCA_USAGE;
    const detectorUsagePriceId = process.env.STRIPE_PRICE_ID_DETECTOR_USAGE;
    const meteredPriceIds = new Set(
      [aiUsagePriceId, rcaUsagePriceId, detectorUsagePriceId].filter((p): p is string =>
        Boolean(p),
      ),
    );
    const planItem = subscription.items.data.find((item) => !meteredPriceIds.has(item.price.id));

    if (!planItem) {
      console.warn(`[Billing] No plan subscription item found for ${subscriptionId}`);
      return;
    }

    if (planItem.quantity !== quantity) {
      await stripeClient.subscriptionItems.update(planItem.id, {
        quantity,
        proration_behavior: "none",
      });
      console.log(`[Billing] Updated Stripe quantity: ${planItem.quantity} -> ${quantity}`);
    }
  } catch (error) {
    console.error(`[Billing] Failed to update Stripe for subscription ${subscriptionId}:`, error);
  }
}

/**
 * Report AI run overage to Stripe via meter events.
 * Units are at $0.01 each. The unit count includes both:
 * - Run overage fee: $10 per 100-run block (rounded up), 1 block = 1000 units
 * - System model token markup: 1.05x of token cost on overage runs (granular)
 * Returns true if successfully reported.
 */
/**
 * Report managed (system-source) detector inference token cost to Stripe.
 * Pricing: 1.05× pass-through, billed at $0.01/unit. No quota, no cap —
 * informational meter; every system-source dollar is billed.
 *
 * Idempotent across hourly runs via lastReportedUnits delta tracking. The
 * underlying system-token cost is aggregated from `aIMessage` rows with
 * kind="detector" and isByok=false; this function just pushes the delta.
 */
export async function reportDetectorOverageToStripe(
  workspaceId: string,
  customerId: string,
  units: number,
  stripeClient: Stripe,
): Promise<boolean> {
  if (units <= 0) return false;

  try {
    await stripeClient.billing.meterEvents.create({
      event_name: "detector_usage",
      payload: {
        stripe_customer_id: customerId,
        value: String(units),
      },
      timestamp: Math.floor(Date.now() / 1000),
    });
    console.log(
      `[Billing] Reported detector usage to Stripe: workspace=${workspaceId}, delta=${units} units ($${(units * 0.01).toFixed(2)})`,
    );
    return true;
  } catch (error) {
    console.error(
      `[Billing] Failed to report detector usage to Stripe for workspace ${workspaceId}:`,
      error,
    );
    return false;
  }
}

async function reportAiRunOverageToStripe(
  workspaceId: string,
  customerId: string,
  units: number,
  stripeClient: Stripe,
): Promise<boolean> {
  if (units <= 0) return false;

  try {
    await stripeClient.billing.meterEvents.create({
      event_name: "ai_usage",
      payload: {
        stripe_customer_id: customerId,
        value: String(units),
      },
      timestamp: Math.floor(Date.now() / 1000),
    });
    console.log(
      `[Billing] Reported AI run overage to Stripe: workspace=${workspaceId}, delta=${units} units ($${(units * 0.01).toFixed(2)})`,
    );
    return true;
  } catch (error) {
    console.error(
      `[Billing] Failed to report AI run overage to Stripe for workspace ${workspaceId}:`,
      error,
    );
    return false;
  }
}

/**
 * Report RCA run overage to Stripe via meter events on a separate Stripe
 * product (`STRIPE_PRICE_ID_RCA_USAGE`). Same shape as AI run overage:
 * units at $0.01 each, including:
 *  - Run overage fee: $10 per 100-run block (rounded up), 1 block = 1000 units
 *  - System token markup: 1.05x of system-source RCA inference cost (granular)
 * Returns true if successfully reported.
 */
export async function reportRcaRunOverageToStripe(
  workspaceId: string,
  customerId: string,
  units: number,
  stripeClient: Stripe,
): Promise<boolean> {
  if (units <= 0) return false;

  try {
    await stripeClient.billing.meterEvents.create({
      event_name: "rca_usage",
      payload: {
        stripe_customer_id: customerId,
        value: String(units),
      },
      timestamp: Math.floor(Date.now() / 1000),
    });
    console.log(
      `[Billing] Reported RCA run overage to Stripe: workspace=${workspaceId}, delta=${units} units ($${(units * 0.01).toFixed(2)})`,
    );
    return true;
  } catch (error) {
    console.error(
      `[Billing] Failed to report RCA run overage to Stripe for workspace ${workspaceId}:`,
      error,
    );
    return false;
  }
}

// =============================================================================
// Budget Alert Reconciliation
//
// Safety net for the event-driven Redis budget check in the Python ingest path.
// Runs hourly as part of the billing cron. For each project with budget
// detectors, queries authoritative ClickHouse spend and enqueues a budget
// finding if the threshold is exceeded and no recent finding exists.
// =============================================================================

const BUDGET_WINDOW_MS: Record<string, number> = {
  "1h": 3_600_000,
  "24h": 86_400_000,
  "7d": 604_800_000,
  "30d": 2_592_000_000,
};

const BACKEND_URL = process.env.BACKEND_INTERNAL_URL || "http://localhost:8000";
const INTERNAL_API_SECRET = process.env.INTERNAL_API_SECRET || "";

function deterministicFindingId(projectId: string, detectorId: string, windowKey: string): string {
  const raw = `budget:${projectId}:${detectorId}:${windowKey}`;
  const h = crypto.createHash("sha256").update(raw).digest("hex").slice(0, 32);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

async function reconcileBudgetAlerts(workspaceId: string, projectIds: string[]): Promise<void> {
  if (projectIds.length === 0) return;

  // 1. Find budget detectors across all projects in this workspace
  const budgetDetectors = await prisma.detector.findMany({
    where: {
      projectId: { in: projectIds },
      template: "budget",
      enabled: true,
    },
    include: { trigger: true },
  });

  if (budgetDetectors.length === 0) return;

  for (const detector of budgetDetectors) {
    try {
      // 2. Extract budget config from trigger conditions
      const conditions = Array.isArray(detector.trigger?.conditions)
        ? (detector.trigger.conditions as Array<{ field: string; value: unknown }>)
        : [];

      let thresholdUsd: number | null = null;
      let window: string | null = null;
      for (const cond of conditions) {
        if (cond.field === "budget_threshold_usd") thresholdUsd = Number(cond.value);
        if (cond.field === "budget_window") window = String(cond.value);
      }

      if (thresholdUsd == null || !window || !(window in BUDGET_WINDOW_MS)) continue;

      // 3. Query ClickHouse for project spend in the configured window
      const windowMs = BUDGET_WINDOW_MS[window];
      const startTime = new Date(Date.now() - windowMs);

      const response = await fetch(
        `${BACKEND_URL}/api/v1/internal/projects/${detector.projectId}/spend?start_time=${startTime.toISOString()}`,
        { headers: { "X-Internal-Secret": INTERNAL_API_SECRET } },
      );

      if (!response.ok) {
        console.warn(
          `[Billing] Budget reconciliation: failed to query spend for project ${detector.projectId}: HTTP ${response.status}`,
        );
        continue;
      }

      const { total_cost } = (await response.json()) as { total_cost: number };

      if (total_cost < thresholdUsd) continue;

      // 4. Check if a recent finding already exists (don't duplicate)
      const findingResponse = await fetch(
        `${BACKEND_URL}/api/v1/internal/detector-runs?project_id=${detector.projectId}&detector_id=${detector.id}&limit=1`,
        { headers: { "X-Internal-Secret": INTERNAL_API_SECRET } },
      );

      if (findingResponse.ok) {
        const { data } = (await findingResponse.json()) as {
          data: Array<{ timestamp: string; finding_id: string | null }>;
        };
        if (data.length > 0 && data[0].finding_id) {
          const lastFindingTime = new Date(data[0].timestamp).getTime();
          if (Date.now() - lastFindingTime < windowMs) {
            // A finding already exists within this window — skip
            continue;
          }
        }
      }

      // 5. No recent finding — log, reset Redis counter, and enqueue the alert to recover it
      console.log(
        `[Billing] Budget reconciliation: project ${detector.projectId} ` +
          `detector ${detector.id} spend $${total_cost.toFixed(2)} >= threshold $${thresholdUsd} ` +
          `in ${window} window. Recovering lost alert and resetting Redis counter...`,
      );

      const windowSecs = windowMs / 1000;
      const windowEpoch = Math.floor(Date.now() / 1000 / windowSecs) * windowSecs;
      const windowKey = `${window}-${windowEpoch}`;

      const findingId = deterministicFindingId(detector.projectId, detector.id, windowKey);
      const summary =
        `Budget alert: $${total_cost.toFixed(2)} spent in the last ${window} ` +
        `(threshold: $${thresholdUsd.toFixed(2)})`;

      const jobData = {
        traceId: "",
        detectorIds: [],
        projectId: detector.projectId,
        budgetAlert: {
          findingId,
          detectorId: detector.id,
          detectorName: detector.name,
          summary,
          data: {
            threshold_usd: thresholdUsd,
            current_spend_usd: Number(total_cost.toFixed(4)),
            window,
          },
        },
      };

      const jobId = `budget-${detector.projectId}-${detector.id}-${windowKey}`;
      const connection = createRedisConnection();
      try {
        const queue = createDetectorRunQueue(connection);

        // Enqueue the alert finding to BullMQ
        await queue.add("budget-alert", jobData, {
          jobId,
          removeOnComplete: 100,
          removeOnFail: 50,
          attempts: 3,
        });

        // Sync the Redis spend counter and set TTL to authoritative ClickHouse spend.
        // Counter key must include the epoch to match the Python ingest path format:
        //   budget:project:{projectId}:{detectorId}:{window}-{epoch}
        const counterKey = `budget:project:${detector.projectId}:${detector.id}:${windowKey}`;
        await connection.set(counterKey, String(total_cost), "EX", windowSecs);

        // Set cooldown key to avoid double alerting in ingestion path
        const cooldownKey = `budget:alert:cooldown:${detector.projectId}:${detector.id}:${windowKey}`;
        await connection.set(cooldownKey, "1", "EX", windowSecs);

        console.log(
          `[Billing] Budget reconciliation alert enqueued & Redis counter synced for detector ${detector.id}`,
        );
        await queue.close();
      } finally {
        await connection.quit();
      }
    } catch (e) {
      console.error(`[Billing] Budget reconciliation failed for detector ${detector.id}:`, e);
    }
  }
}
