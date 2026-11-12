/**
 * When a Loop runs: every N hours (UTC arithmetic), or daily / weekly at an
 * hour of the day in an IANA timezone. No cron in v1.
 */
import { z } from "zod";
import { canonicalTimezone, nextSlotAfter, type SlotSchedule } from "../schedule/index.ts";

export const LOOP_SCHEDULE_KINDS = ["interval", "daily", "weekly"] as const;
export type LoopScheduleKind = (typeof LOOP_SCHEDULE_KINDS)[number];

export const MIN_INTERVAL_HOURS = 1;
export const MAX_INTERVAL_HOURS = 24;

const hourOfDay = z
  .number("hour must be a whole number from 0 to 23")
  .int("hour must be a whole number from 0 to 23")
  .min(0, "hour must be a whole number from 0 to 23")
  .max(23, "hour must be a whole number from 0 to 23");

// Stored canonically ("europe/berlin" -> "Europe/Berlin"), so one zone has one spelling.
const timezone = z.string("timezone must be a valid IANA timezone name").transform((value, ctx) => {
  const canonical = canonicalTimezone(value);
  if (canonical === null) {
    ctx.addIssue({ code: "custom", message: "timezone must be a valid IANA timezone name" });
    return z.NEVER;
  }
  return canonical;
});

export const loopScheduleSchema = z.discriminatedUnion(
  "kind",
  [
    z.object({
      kind: z.literal("interval"),
      intervalHours: z
        .number("intervalHours must be a whole number from 1 to 24")
        .int("intervalHours must be a whole number from 1 to 24")
        .min(MIN_INTERVAL_HOURS, "intervalHours must be a whole number from 1 to 24")
        .max(MAX_INTERVAL_HOURS, "intervalHours must be a whole number from 1 to 24"),
    }),
    z.object({ kind: z.literal("daily"), hour: hourOfDay, timezone }),
    z.object({
      kind: z.literal("weekly"),
      weekday: z
        .number("weekday must be a whole number from 1 (Monday) to 7 (Sunday)")
        .int("weekday must be a whole number from 1 (Monday) to 7 (Sunday)")
        .min(1, "weekday must be a whole number from 1 (Monday) to 7 (Sunday)")
        .max(7, "weekday must be a whole number from 1 (Monday) to 7 (Sunday)"),
      hour: hourOfDay,
      timezone,
    }),
  ],
  { error: 'schedule.kind must be "interval", "daily" or "weekly"' },
);

/** What a client sends (timezone spelling not yet canonical). */
export type LoopScheduleInput = z.input<typeof loopScheduleSchema>;
/** What is stored and returned. */
export type LoopSchedule = z.output<typeof loopScheduleSchema>;

/** The columns of `loops` that hold a schedule. */
export interface LoopScheduleColumns {
  scheduleKind: string;
  intervalHours: number | null;
  weekday: number | null;
  hour: number | null;
  timezone: string | null;
}

export function scheduleToColumns(schedule: LoopSchedule): LoopScheduleColumns {
  switch (schedule.kind) {
    case "interval":
      return {
        scheduleKind: "interval",
        intervalHours: schedule.intervalHours,
        weekday: null,
        hour: null,
        timezone: null,
      };
    case "daily":
      return {
        scheduleKind: "daily",
        intervalHours: null,
        weekday: null,
        hour: schedule.hour,
        timezone: schedule.timezone,
      };
    case "weekly":
      return {
        scheduleKind: "weekly",
        intervalHours: null,
        weekday: schedule.weekday,
        hour: schedule.hour,
        timezone: schedule.timezone,
      };
  }
}

export function scheduleFromColumns(row: LoopScheduleColumns): LoopSchedule {
  const parsed = loopScheduleSchema.safeParse({
    kind: row.scheduleKind,
    intervalHours: row.intervalHours,
    weekday: row.weekday,
    hour: row.hour,
    timezone: row.timezone,
  });
  if (!parsed.success) throw new Error(`Stored Loop schedule is invalid: ${parsed.error.message}`);
  return parsed.data;
}

/**
 * The first run after `from`. An interval counts from `from` (the slot just
 * claimed, or the creation time), so slots never drift; daily and weekly
 * follow the local calendar, DST included.
 */
export function nextRunAt(schedule: LoopSchedule, from: Date): Date {
  if (schedule.kind === "interval") {
    return new Date(from.getTime() + schedule.intervalHours * 3_600_000);
  }
  const slots: SlotSchedule = {
    cadence: schedule.kind,
    weekday: schedule.kind === "weekly" ? schedule.weekday : 1,
    hour: schedule.hour,
    timezone: schedule.timezone,
  };
  return nextSlotAfter(slots, from);
}
