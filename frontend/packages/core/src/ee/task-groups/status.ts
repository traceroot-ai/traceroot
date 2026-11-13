import type { PrismaClient } from "@prisma/client";
import {
  DEFAULT_DAILY_COST_CAP_USD,
  SUMMARY_COST_ESTIMATE_USD,
  type TaskGroupStatus,
} from "./constants.ts";

/** The UTC calendar day of an instant, as a Date at 00:00 UTC (a Postgres DATE key). */
export function utcDay(at: Date): Date {
  return new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()));
}

export interface TaskGroupState {
  enabled: boolean;
  dailyCostCapUsd: number;
  spentTodayUsd: number;
  summariesToday: number;
  status: TaskGroupStatus;
}

/**
 * Derive the status line from the switch, the key, today's spend and whether
 * enough traces have been summarized for groups to exist.
 */
export function deriveStatus(params: {
  enabled: boolean;
  keyConfigured: boolean;
  spentTodayUsd: number;
  dailyCostCapUsd: number;
  groupsExist: boolean;
}): TaskGroupStatus {
  if (!params.enabled) return "off";
  if (!params.keyConfigured) return "no_key";
  if (params.spentTodayUsd + SUMMARY_COST_ESTIMATE_USD > params.dailyCostCapUsd) return "capped";
  return params.groupsExist ? "active" : "collecting";
}

/** Settings and today's spend for a project; defaults when it has never been configured. */
export async function readTaskGroupState(
  db: Pick<PrismaClient, "taskGroupSettings" | "taskGroupSpendDay">,
  params: {
    projectId: string;
    now?: Date;
    keyConfigured: boolean;
    groupsExist: boolean;
  },
): Promise<TaskGroupState> {
  const day = utcDay(params.now ?? new Date());
  const [settings, spend] = await Promise.all([
    db.taskGroupSettings.findUnique({ where: { projectId: params.projectId } }),
    db.taskGroupSpendDay.findUnique({
      where: { projectId_day: { projectId: params.projectId, day } },
    }),
  ]);
  const enabled = settings?.enabled ?? false;
  const dailyCostCapUsd = settings?.dailyCostCapUsd ?? DEFAULT_DAILY_COST_CAP_USD;
  const spentTodayUsd = spend?.costUsd ?? 0;
  return {
    enabled,
    dailyCostCapUsd,
    spentTodayUsd,
    summariesToday: spend?.summaries ?? 0,
    status: deriveStatus({
      enabled,
      keyConfigured: params.keyConfigured,
      spentTodayUsd,
      dailyCostCapUsd,
      groupsExist: params.groupsExist,
    }),
  };
}

/** Add one chunk's spend to today's row, creating it on the first write. */
export async function addTaskGroupSpend(
  db: Pick<PrismaClient, "taskGroupSpendDay">,
  params: { projectId: string; now?: Date; summaries: number; costUsd: number },
): Promise<void> {
  const day = utcDay(params.now ?? new Date());
  await db.taskGroupSpendDay.upsert({
    where: { projectId_day: { projectId: params.projectId, day } },
    create: {
      projectId: params.projectId,
      day,
      summaries: params.summaries,
      costUsd: params.costUsd,
    },
    update: {
      summaries: { increment: params.summaries },
      costUsd: { increment: params.costUsd },
      updateTime: new Date(),
    },
  });
}
