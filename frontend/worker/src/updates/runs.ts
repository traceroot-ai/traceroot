import { randomUUID } from "node:crypto";
import type { PrismaClient, ProjectUpdateRun } from "@traceroot/core";
import type { UpdateScheduleSettings, UpdateWindows } from "@traceroot/core/updates";

export type RunTrigger = "scheduled" | "manual";

export type RunDb = Pick<PrismaClient, "projectUpdateRun">;

/**
 * The identity of a scheduled run: one per project and slot. Two ticks, or two
 * workers, that both reach the same slot build the same key and the unique
 * index lets only one row in.
 */
export function scheduledDedupeKey(projectId: string, slotAt: Date): string {
  return `scheduled:${projectId}:${slotAt.toISOString()}`;
}

/** A manual run is never merged with another, even for the same slot. */
export function manualDedupeKey(projectId: string): string {
  return `manual:${projectId}:${randomUUID()}`;
}

export interface InsertRunInput {
  projectId: string;
  trigger: RunTrigger;
  windows: UpdateWindows;
  schedule: Pick<UpdateScheduleSettings, "frequency" | "timezone">;
  /** Only for tests; defaults to the key the trigger implies. */
  dedupeKey?: string;
}

export interface InsertRunResult {
  run: ProjectUpdateRun;
  /** False when the slot already had a run and this call found it. */
  created: boolean;
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" && error !== null && (error as { code?: unknown }).code === "P2002"
  );
}

/**
 * Record a run for a slot, or find the one already recorded. Never starts the
 * run itself, so a caller that lost the race simply sees `created: false`.
 */
export async function insertRun(db: RunDb, input: InsertRunInput): Promise<InsertRunResult> {
  const { projectId, trigger, windows, schedule } = input;
  const dedupeKey =
    input.dedupeKey ??
    (trigger === "scheduled"
      ? scheduledDedupeKey(projectId, windows.slotAt)
      : manualDedupeKey(projectId));
  // Look first: inside a transaction a failed insert would abort it, so the usual
  // path must not rely on catching the duplicate.
  const existing = await db.projectUpdateRun.findUnique({ where: { dedupeKey } });
  if (existing) return { run: existing, created: false };
  try {
    const run = await db.projectUpdateRun.create({
      data: {
        projectId,
        dedupeKey,
        trigger,
        slotAt: windows.slotAt,
        windowStart: windows.windowStart,
        windowEnd: windows.windowEnd,
        prevWindowStart: windows.prevWindowStart,
        prevWindowEnd: windows.prevWindowEnd,
        frequency: schedule.frequency,
        timezone: schedule.timezone,
      },
    });
    return { run, created: true };
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    const run = await db.projectUpdateRun.findUnique({ where: { dedupeKey } });
    if (!run) throw error;
    return { run, created: false };
  }
}
