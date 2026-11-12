/**
 * Calendar slots for a schedule that fires at an hour of the local day.
 *
 * A slot is one scheduled instant (for example Monday 09:00 in Berlin). Slots
 * follow the local calendar, so across a daylight-saving change a weekly gap
 * is 167 or 169 hours, not a fixed 168. Only daily and weekly cadences live
 * here; a fixed-interval cadence needs no timezone and is plain arithmetic in
 * its caller.
 */

export interface SlotSchedule {
  cadence: "daily" | "weekly";
  /** ISO weekday, 1 = Monday ... 7 = Sunday. Ignored for a daily cadence. */
  weekday: number;
  /** Local wall-clock hour, 0..23. */
  hour: number;
  /** IANA timezone name. */
  timezone: string;
}

interface LocalDate {
  y: number;
  m: number; // 1..12
  d: number;
}

interface ZonedParts extends LocalDate {
  hour: number;
  minute: number;
  second: number;
}

const DAY_MS = 86_400_000;

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timezone: string): Intl.DateTimeFormat {
  let formatter = formatterCache.get(timezone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
    });
    formatterCache.set(timezone, formatter);
  }
  return formatter;
}

/** The wall-clock fields of an instant in a timezone. */
export function zonedParts(at: Date, timezone: string): ZonedParts {
  const fields: Record<string, number> = {};
  for (const part of formatterFor(timezone).formatToParts(at)) {
    if (part.type !== "literal") fields[part.type] = Number(part.value);
  }
  return {
    y: fields.year,
    m: fields.month,
    d: fields.day,
    hour: fields.hour,
    minute: fields.minute,
    second: fields.second,
  };
}

/** Offset of the timezone from UTC at an instant, in milliseconds (local minus UTC). */
function offsetMs(at: Date, timezone: string): number {
  const p = zonedParts(at, timezone);
  const asUtc = Date.UTC(p.y, p.m - 1, p.d, p.hour, p.minute, p.second);
  return asUtc - Math.floor(at.getTime() / 1000) * 1000;
}

/**
 * The instant a local date and hour occurs in a timezone.
 *
 * An hour that happens twice (clocks going back) resolves to its first
 * occurrence. An hour that never happens (clocks going forward) resolves
 * using the offset from before the change, which lands just after the gap.
 */
export function localToUtc(date: LocalDate, hour: number, timezone: string): Date {
  const naive = Date.UTC(date.y, date.m - 1, date.d, hour);
  const before = naive - offsetMs(new Date(naive - DAY_MS), timezone);
  const after = naive - offsetMs(new Date(naive + DAY_MS), timezone);
  const matches = (ms: number) => {
    const p = zonedParts(new Date(ms), timezone);
    return p.y === date.y && p.m === date.m && p.d === date.d && p.hour === hour;
  };
  const valid = [before, after].filter(matches);
  if (valid.length > 0) return new Date(Math.min(...valid));
  return new Date(before);
}

function addDays(date: LocalDate, days: number): LocalDate {
  const moved = new Date(Date.UTC(date.y, date.m - 1, date.d) + days * DAY_MS);
  return { y: moved.getUTCFullYear(), m: moved.getUTCMonth() + 1, d: moved.getUTCDate() };
}

/** ISO weekday (1 = Monday ... 7 = Sunday) of a calendar date. */
function isoWeekday(date: LocalDate): number {
  const day = new Date(Date.UTC(date.y, date.m - 1, date.d)).getUTCDay();
  return day === 0 ? 7 : day;
}

function slotsOnDate(schedule: SlotSchedule, date: LocalDate): boolean {
  return schedule.cadence === "daily" || isoWeekday(date) === schedule.weekday;
}

/** The latest slot at or before `at`. */
export function latestSlotAtOrBefore(schedule: SlotSchedule, at: Date): Date {
  let date: LocalDate = zonedParts(at, schedule.timezone);
  for (let back = 0; back <= 8; back += 1) {
    if (slotsOnDate(schedule, date)) {
      const slot = localToUtc(date, schedule.hour, schedule.timezone);
      if (slot.getTime() <= at.getTime()) return slot;
    }
    date = addDays(date, -1);
  }
  throw new Error("No slot found within eight days; the schedule is not valid.");
}

/** The first slot strictly after `at`. */
export function nextSlotAfter(schedule: SlotSchedule, at: Date): Date {
  let date: LocalDate = zonedParts(at, schedule.timezone);
  for (let ahead = 0; ahead <= 8; ahead += 1) {
    if (slotsOnDate(schedule, date)) {
      const slot = localToUtc(date, schedule.hour, schedule.timezone);
      if (slot.getTime() > at.getTime()) return slot;
    }
    date = addDays(date, 1);
  }
  throw new Error("No slot found within eight days; the schedule is not valid.");
}
