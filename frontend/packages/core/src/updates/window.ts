/**
 * Slots and windows of the background update.
 *
 * A slot is one scheduled instant (for example Monday 09:00 in Berlin). The
 * window an update covers runs from the previous slot to this one, and is
 * derived from the slot, never from the moment the run happens to start. Slots
 * follow the local calendar, so across a daylight-saving change a weekly
 * window is 167 or 169 hours long, not a fixed 168.
 *
 * The comparison window is the same length of local calendar before it. A
 * weekly update compares with the week before. A daily update compares with
 * the same weekday one week earlier, so weekday seasonality does not read as a
 * change.
 */
import type { UpdateScheduleSettings } from "./schedule.ts";

export interface UpdateWindows {
  slotAt: Date;
  windowStart: Date;
  windowEnd: Date;
  prevWindowStart: Date;
  prevWindowEnd: Date;
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

const DAY_MS = 86_400_000;

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

function slotsOnDate(schedule: UpdateScheduleSettings, date: LocalDate): boolean {
  return schedule.frequency === "daily" || isoWeekday(date) === schedule.weekday;
}

const stepDays = (schedule: UpdateScheduleSettings) => (schedule.frequency === "daily" ? 1 : 7);

/** The latest slot at or before `at`. */
export function latestSlotAtOrBefore(schedule: UpdateScheduleSettings, at: Date): Date {
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
export function nextSlotAfter(schedule: UpdateScheduleSettings, at: Date): Date {
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

/**
 * The local date a slot was scheduled for. Usually the date it shows. A slot whose
 * hour fell in a skipped stretch of local time was moved to just after the gap,
 * which can be the next date, so the date is the one whose own slot is this instant.
 */
function localDateOf(slot: Date, timezone: string, hour: number): LocalDate {
  const shown = zonedParts(slot, timezone);
  const candidates: LocalDate[] = [shown, addDays(shown, -1)];
  const match = candidates.find(
    (date) => localToUtc(date, hour, timezone).getTime() === slot.getTime(),
  );
  const chosen = match ?? shown;
  return { y: chosen.y, m: chosen.m, d: chosen.d };
}

/** The slot one cadence step before `slot`, on the local calendar. */
export function previousSlot(schedule: UpdateScheduleSettings, slot: Date): Date {
  const date = addDays(localDateOf(slot, schedule.timezone, schedule.hour), -stepDays(schedule));
  return localToUtc(date, schedule.hour, schedule.timezone);
}

/** The windows a slot covers: its own and the one it is compared with. */
export function windowsForSlot(schedule: UpdateScheduleSettings, slotAt: Date): UpdateWindows {
  const windowStart = previousSlot(schedule, slotAt);
  const windowEnd = slotAt;
  if (schedule.frequency === "weekly") {
    return {
      slotAt,
      windowStart,
      windowEnd,
      prevWindowStart: previousSlot(schedule, windowStart),
      prevWindowEnd: windowStart,
    };
  }
  const endDate = addDays(localDateOf(slotAt, schedule.timezone, schedule.hour), -7);
  const startDate = addDays(localDateOf(windowStart, schedule.timezone, schedule.hour), -7);
  return {
    slotAt,
    windowStart,
    windowEnd,
    prevWindowStart: localToUtc(startDate, schedule.hour, schedule.timezone),
    prevWindowEnd: localToUtc(endDate, schedule.hour, schedule.timezone),
  };
}

/** The windows of the latest slot that has already passed at `now`. */
export function windowsAt(schedule: UpdateScheduleSettings, now: Date): UpdateWindows {
  return windowsForSlot(schedule, latestSlotAtOrBefore(schedule, now));
}
