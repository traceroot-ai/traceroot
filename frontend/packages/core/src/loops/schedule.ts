/**
 * When a Loop runs: every N hours (UTC arithmetic), or daily / weekly at an
 * hour of the day in an IANA timezone.
 */
import { z } from "zod";
import { canonicalTimeZone, tzOffsetMinutes } from "../lib/timezone.ts";

export const LOOP_SCHEDULE_KINDS = ["interval", "daily", "weekly"] as const;
export type LoopScheduleKind = (typeof LOOP_SCHEDULE_KINDS)[number];

export const MIN_INTERVAL_HOURS = 1;
export const MAX_INTERVAL_HOURS = 24;

const intervalRange = `intervalHours must be a whole number from ${MIN_INTERVAL_HOURS} to ${MAX_INTERVAL_HOURS}`;

const hourOfDay = z
  .number("hour must be a whole number from 0 to 23")
  .int("hour must be a whole number from 0 to 23")
  .min(0, "hour must be a whole number from 0 to 23")
  .max(23, "hour must be a whole number from 0 to 23");

// Stored canonically ("europe/berlin" -> "Europe/Berlin"), so one zone has one spelling.
const timezone = z.string("timezone must be a valid IANA timezone name").transform((value, ctx) => {
  const canonical = canonicalTimeZone(value);
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
        .number(intervalRange)
        .int(intervalRange)
        .min(MIN_INTERVAL_HOURS, intervalRange)
        .max(MAX_INTERVAL_HOURS, intervalRange),
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
  return nextSlotAfter(schedule, from);
}

// ---------------------------------------------------------------------------
// Calendar slots (daily and weekly)
//
// A slot is one scheduled instant (for example Monday 09:00 in Berlin). Slots
// follow the local calendar, so across a daylight-saving change a weekly gap
// is 167 or 169 hours, not a fixed 168.
// ---------------------------------------------------------------------------

type CalendarSchedule = Exclude<LoopSchedule, { kind: "interval" }>;

interface LocalDate {
  y: number;
  m: number; // 1..12
  d: number;
}

const DAY_MS = 86_400_000;

/** The local calendar date and hour of an instant in a timezone. */
function zonedParts(at: Date, timezone: string): LocalDate & { hour: number } {
  const format = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hourCycle: "h23",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
  });
  const part = Object.fromEntries(format.formatToParts(at).map((p) => [p.type, Number(p.value)]));
  return { y: part.year, m: part.month, d: part.day, hour: part.hour };
}

/**
 * The instant a local date and hour occurs in a timezone. An hour that happens
 * twice (clocks going back) resolves to its first occurrence. An hour that
 * never happens (clocks going forward) resolves using the offset from before
 * the change, which lands just after the gap.
 */
function localToUtc(date: LocalDate, hour: number, timezone: string): Date {
  const naive = Date.UTC(date.y, date.m - 1, date.d, hour);
  const offsetMsAt = (ms: number) => tzOffsetMinutes(new Date(ms), timezone) * 60_000;
  const before = naive - offsetMsAt(naive - DAY_MS);
  const after = naive - offsetMsAt(naive + DAY_MS);
  const matches = (ms: number) => {
    const p = zonedParts(new Date(ms), timezone);
    return p.y === date.y && p.m === date.m && p.d === date.d && p.hour === hour;
  };
  const valid = [before, after].filter(matches);
  return new Date(valid.length > 0 ? Math.min(...valid) : before);
}

/** ISO weekday (1 = Monday ... 7 = Sunday) of a calendar date. */
function isoWeekday(date: LocalDate): number {
  const day = new Date(Date.UTC(date.y, date.m - 1, date.d)).getUTCDay();
  return day === 0 ? 7 : day;
}

/** The first slot strictly after `at`. */
function nextSlotAfter(schedule: CalendarSchedule, at: Date): Date {
  const today = zonedParts(at, schedule.timezone);
  for (let ahead = 0; ahead <= 8; ahead += 1) {
    const moved = new Date(Date.UTC(today.y, today.m - 1, today.d) + ahead * DAY_MS);
    const date = { y: moved.getUTCFullYear(), m: moved.getUTCMonth() + 1, d: moved.getUTCDate() };
    if (schedule.kind === "daily" || isoWeekday(date) === schedule.weekday) {
      const slot = localToUtc(date, schedule.hour, schedule.timezone);
      if (slot.getTime() > at.getTime()) return slot;
    }
  }
  throw new Error("No slot found within eight days; the schedule is not valid.");
}
