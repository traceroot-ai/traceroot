/** How a loop and its runs read on screen: labels, tones and the schedule in words. */
import {
  nextRunAt,
  type LoopRunStatus,
  type LoopSchedule,
  type LoopStatus,
} from "@traceroot/core/loops/pure";
import type { AlertTone } from "@/features/alerts/components/alert-display";

const WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
export const weekdayName = (isoWeekday: number) => WEEKDAYS[isoWeekday - 1] ?? "";

export const hourLabel = (hour: number) => `${String(hour).padStart(2, "0")}:00`;

const GMT_OFFSET = /^GMT[+-]/;

/** A zone's short name at `at` ("CET", "EST", "UTC"); an offset like "GMT+9" where none is common. */
export function shortZoneName(timezone: string, at: Date = new Date()): string {
  const name = (locale: string) =>
    new Intl.DateTimeFormat(locale, { timeZone: timezone, timeZoneName: "short" })
      .formatToParts(at)
      .find((part) => part.type === "timeZoneName")?.value ?? timezone;
  // en-US knows the American abbreviations, en-GB the European ones.
  const us = name("en-US");
  return GMT_OFFSET.test(us) ? name("en-GB") : us;
}

/** "Daily at 09:00 (CET)": a clock time carries its zone's short name, an interval none. */
export function describeSchedule(schedule: LoopSchedule, at: Date = new Date()): string {
  switch (schedule.kind) {
    case "interval":
      return schedule.intervalHours === 1 ? "Every hour" : `Every ${schedule.intervalHours} hours`;
    case "daily":
      return `Daily at ${hourLabel(schedule.hour)} (${shortZoneName(schedule.timezone, at)})`;
    case "weekly":
      return `${weekdayName(schedule.weekday)}s at ${hourLabel(schedule.hour)} (${shortZoneName(schedule.timezone, at)})`;
  }
}

/** The full zone behind the short name, for a tooltip; nothing for an interval. */
export function scheduleZoneTitle(schedule: LoopSchedule): string | undefined {
  return schedule.kind === "interval" ? undefined : `Runs on ${schedule.timezone} time`;
}

/** How far off a run is: "in 45m", "in 3h 20m", "in 2d"; "Due now" once its time has passed. */
export function nextRunLabel(at: Date, now: Date): string {
  const minutes = Math.round((at.getTime() - now.getTime()) / 60_000);
  if (minutes <= 0) return "Due now";
  if (minutes < 60) return `in ${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    const rest = minutes % 60;
    return rest > 0 ? `in ${hours}h ${rest}m` : `in ${hours}h`;
  }
  return `in ${Math.round(hours / 24)}d`;
}

/** The exact time behind a relative next run: in the loop's zone, and in the viewer's when it differs. */
export function nextRunTitle(at: Date, timezone: string | null, viewerZone: string | null): string {
  const loopTime = formatInZone(at, timezone);
  // The viewer's zone is unknown until the page hydrates.
  const yours = viewerZone ? formatInZone(at, viewerZone) : loopTime;
  return yours === loopTime ? loopTime : `${loopTime}\n${yours} your time`;
}

/** An instant as a person in the loop's zone reads it ("Thu 12 Nov, 09:00 CET"); UTC for an interval. */
export function formatInZone(at: Date, timezone: string | null): string {
  const zone = timezone ?? "UTC";
  const local = new Intl.DateTimeFormat("en-GB", {
    timeZone: zone,
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  })
    .format(at)
    .replace(/,? (\d{2}:\d{2})/, ", $1");
  return `${local} ${shortZoneName(zone, at)}`;
}

/** The first run after `from`, formatted in the schedule's own zone. */
export function describeNextRun(schedule: LoopSchedule, from: Date): string {
  return formatInZone(
    nextRunAt(schedule, from),
    schedule.kind === "interval" ? null : schedule.timezone,
  );
}

export const STATUS_LABEL: Record<LoopStatus, string> = {
  active: "Active",
  paused: "Paused",
  paused_by_system: "Paused by system",
};

export const STATUS_TONE: Record<LoopStatus, AlertTone> = {
  active: "ok",
  paused: "neutral",
  paused_by_system: "warning",
};

/** Why the system paused a loop: only a streak of failed scheduled runs does. */
export function pauseDetail(status: LoopStatus, streak: number) {
  if (status !== "paused_by_system") return undefined;
  return `Paused automatically after ${streak} scheduled runs in a row failed. Fix the cause (see the latest failed run), then resume.`;
}

export const RUN_STATUS_LABEL: Record<LoopRunStatus, string> = {
  pending: "Queued",
  running: "Running",
  succeeded: "Succeeded",
  quiet: "Quiet",
  failed: "Failed",
  timed_out: "Timed out",
  skipped_blocked: "Skipped (plan limit)",
};

/** The one-word status a runs table shows ("Skipped"); the full outcome goes in its title. */
export function runStatusShort(status: LoopRunStatus): string {
  return RUN_STATUS_LABEL[status].replace(/ \(.*\)$/, "");
}

/** "Succeeded · 2 findings" for a run that recorded some, the plain label otherwise. */
export function runOutcomeLabel(status: LoopRunStatus, findingCount: number): string {
  if (status === "succeeded" && findingCount > 0) {
    return `Succeeded · ${findingCount} ${findingCount === 1 ? "finding" : "findings"}`;
  }
  return RUN_STATUS_LABEL[status];
}
