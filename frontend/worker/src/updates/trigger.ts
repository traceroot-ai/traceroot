import type { PrismaClient } from "@traceroot/core";
import {
  DEFAULT_UPDATE_SCHEDULE,
  windowsAt,
  type Clock,
  type UpdateScheduleSettings,
} from "@traceroot/core/updates";
import { insertRun, type InsertRunResult } from "./runs.js";

type TriggerDb = Pick<PrismaClient, "projectUpdateRun" | "projectUpdateSchedule" | "project">;

export class ManualTriggerDisabledError extends Error {
  constructor() {
    super(
      "The manual update trigger is for development and tests only. " +
        "Set TRACEROOT_UPDATES_ALLOW_MANUAL=1 to use it outside them.",
    );
  }
}

/**
 * The manual trigger starts an update on demand and, with a frozen clock, at a
 * chosen instant. It is refused in production unless explicitly allowed, so a
 * stray call cannot produce an off-schedule message for a customer.
 */
export function assertManualTriggerAllowed(env: NodeJS.ProcessEnv = process.env): void {
  const isProduction = env.NODE_ENV === "production";
  if (isProduction && env.TRACEROOT_UPDATES_ALLOW_MANUAL !== "1") {
    throw new ManualTriggerDisabledError();
  }
}

export interface ManualTriggerInput {
  projectId: string;
  clock: Clock;
  env?: NodeJS.ProcessEnv;
}

export interface ManualTriggerResult extends InsertRunResult {
  schedule: UpdateScheduleSettings;
}

/**
 * Create a run for a project as of the clock's "now". The windows come from the
 * project's schedule and the latest slot that has passed at that instant, so
 * the same "now" always gives the same boundaries.
 */
export async function triggerManualRun(
  db: TriggerDb,
  input: ManualTriggerInput,
): Promise<ManualTriggerResult> {
  assertManualTriggerAllowed(input.env);
  const project = await db.project.findFirst({
    where: { id: input.projectId, deleteTime: null },
    select: { id: true },
  });
  if (!project) throw new Error(`Project ${input.projectId} not found.`);

  const row = await db.projectUpdateSchedule.findUnique({ where: { projectId: project.id } });
  const schedule: UpdateScheduleSettings = row
    ? {
        enabled: row.enabled,
        frequency: row.frequency as UpdateScheduleSettings["frequency"],
        weekday: row.weekday,
        hour: row.hour,
        timezone: row.timezone,
      }
    : DEFAULT_UPDATE_SCHEDULE;

  const windows = windowsAt(schedule, input.clock.now());
  const result = await insertRun(db, {
    projectId: project.id,
    trigger: "manual",
    windows,
    schedule,
  });
  return { ...result, schedule };
}
