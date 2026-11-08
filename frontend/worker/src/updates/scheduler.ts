import cron from "node-cron";
import { prisma, type PrismaClient } from "@traceroot/core";
import {
  latestSlotAtOrBefore,
  nextSlotAfter,
  parseScheduleInput,
  windowsForSlot,
} from "@traceroot/core/updates";
import { enqueueUpdateRun, createUpdateRunQueue, type UpdateRunQueue } from "./queue.js";
import { insertRun, type RunDb } from "./runs.js";

/**
 * The due-schedule tick: a cheap database query, not the cadence. A schedule is
 * due when its next slot has passed. The tick moves that slot forward with a
 * compare-and-set, so of two workers (or two overlapping ticks) only one wins,
 * records the run for the slot just passed, and queues it. Windows come from
 * the slot, never from the moment the tick happens to run.
 *
 * A worker that was down across several slots runs the latest one only: each
 * window is a full period of its own, and an update about a week that is long
 * over is not worth sending.
 */

export const UPDATE_TICK_CRON = process.env.UPDATE_TICK_CRON || "*/5 * * * *";
const DUE_LIMIT = 200;
const RECOVER_LIMIT = 100;
/** A run still pending this long after it was recorded probably lost its job. */
const RECOVER_AFTER_MS = 60_000;

type TickDb = RunDb & Pick<PrismaClient, "projectUpdateSchedule">;

const log = (message: string) => console.log(`[Updates] ${message}`);

export interface TickResult {
  claimed: number;
  created: number;
  recovered: number;
}

export async function runUpdateTick(
  db: TickDb,
  queue: UpdateRunQueue,
  now: Date,
): Promise<TickResult> {
  const result: TickResult = { claimed: 0, created: 0, recovered: 0 };

  const due = await db.projectUpdateSchedule.findMany({
    where: { enabled: true, nextSlotAt: { lte: now }, project: { deleteTime: null } },
    orderBy: { nextSlotAt: "asc" },
    take: DUE_LIMIT,
  });

  for (const row of due) {
    const parsed = parseScheduleInput({
      enabled: row.enabled,
      frequency: row.frequency,
      weekday: row.weekday,
      hour: row.hour,
      timezone: row.timezone,
    });
    if (!parsed.ok) {
      log(`skip project=${row.projectId}: stored schedule is invalid (${parsed.error})`);
      continue;
    }
    const schedule = parsed.value;

    const claim = await db.projectUpdateSchedule.updateMany({
      where: { id: row.id, nextSlotAt: row.nextSlotAt },
      data: { nextSlotAt: nextSlotAfter(schedule, now) },
    });
    if (claim.count === 0) continue; // another worker took this slot
    result.claimed += 1;

    const windows = windowsForSlot(schedule, latestSlotAtOrBefore(schedule, now));
    const { run, created } = await insertRun(db, {
      projectId: row.projectId,
      trigger: "scheduled",
      windows,
      schedule,
    });
    if (created) result.created += 1;
    await enqueueUpdateRun(queue, run);
    log(
      `slot project=${row.projectId} slot=${windows.slotAt.toISOString()} run=${run.id} created=${created}`,
    );
  }

  // A run recorded but never queued (the process died between the two) is queued
  // again. The job id is deterministic, so a run that is queued already is a no-op.
  const stale = await db.projectUpdateRun.findMany({
    where: {
      status: "pending",
      trigger: "scheduled",
      createTime: { lt: new Date(now.getTime() - RECOVER_AFTER_MS) },
    },
    orderBy: { createTime: "asc" },
    take: RECOVER_LIMIT,
  });
  for (const run of stale) {
    await enqueueUpdateRun(queue, run);
    result.recovered += 1;
  }
  return result;
}

const TRUTHY = ["true", "1", "yes", "on"];
const FALSY = ["false", "0", "no", "off"];

/** On by default: it only acts on projects that have a schedule row. */
export function isUpdateSchedulerEnabled(
  value: string | undefined = process.env.UPDATES_SCHEDULER_ENABLED,
): boolean {
  const normalized = (value ?? "").trim().toLowerCase();
  if (normalized === "" || TRUTHY.includes(normalized)) return true;
  if (FALSY.includes(normalized)) return false;
  log(
    `UPDATES_SCHEDULER_ENABLED="${value}" is not understood; updates stay off until it is corrected`,
  );
  return false;
}

export interface UpdateSchedulerHandle {
  stop: () => void;
}

export function startUpdateScheduler(): UpdateSchedulerHandle | undefined {
  if (!isUpdateSchedulerEnabled()) {
    log('scheduler disabled (set UPDATES_SCHEDULER_ENABLED="true" to run it)');
    return undefined;
  }
  const { queue, close } = createUpdateRunQueue();
  let isTicking = false;
  const task = cron.schedule(UPDATE_TICK_CRON, async () => {
    if (isTicking || !isUpdateSchedulerEnabled()) return;
    isTicking = true;
    try {
      await runUpdateTick(prisma, queue, new Date());
    } catch (error) {
      console.error("[Updates] tick failed", error);
    } finally {
      isTicking = false;
    }
  });
  log(`scheduler started (${UPDATE_TICK_CRON})`);
  return {
    stop: () => {
      task.stop();
      void close();
    },
  };
}
