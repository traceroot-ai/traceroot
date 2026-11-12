/** How a Loop and its runs read on screen: labels, tones and the schedule in words. */
import {
  nextRunAt,
  type LoopPauseReason,
  type LoopRunStatus,
  type LoopSchedule,
  type LoopStatus,
} from "@traceroot/core/loops/pure";

export type LoopTone = "ok" | "alert" | "warning" | "neutral";

const WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
export const weekdayName = (isoWeekday: number) => WEEKDAYS[isoWeekday - 1] ?? "";

export const hourLabel = (hour: number) => `${String(hour).padStart(2, "0")}:00`;

export function describeSchedule(schedule: LoopSchedule): string {
  switch (schedule.kind) {
    case "interval":
      return schedule.intervalHours === 1 ? "Every hour" : `Every ${schedule.intervalHours} hours`;
    case "daily":
      return `Daily at ${hourLabel(schedule.hour)} ${schedule.timezone}`;
    case "weekly":
      return `${weekdayName(schedule.weekday)}s at ${hourLabel(schedule.hour)} ${schedule.timezone}`;
  }
}

/** An instant as a person in the Loop's zone reads it ("Thu 12 Nov, 09:00 CET"); UTC for an interval. */
export function formatInZone(at: Date, timezone: string | null): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone ?? "UTC",
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZoneName: "short",
  })
    .format(at)
    .replace(/,? (\d{2}:\d{2})/, ", $1");
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

export const STATUS_TONE: Record<LoopStatus, LoopTone> = {
  active: "ok",
  paused: "neutral",
  paused_by_system: "warning",
};

export function pauseDetail(status: LoopStatus, reason: LoopPauseReason | null, streak: number) {
  if (status !== "paused_by_system") return undefined;
  if (reason === "failures") {
    return `Paused automatically after ${streak} scheduled runs in a row failed. Fix the cause (see the latest failed run), then resume.`;
  }
  return "Paused automatically by the system.";
}

export const RUN_STATUS_LABEL: Record<LoopRunStatus, string> = {
  pending: "Queued",
  running: "Running",
  succeeded: "Succeeded",
  quiet: "Quiet",
  failed: "Failed",
  timed_out: "Timed out",
  skipped_precheck: "Skipped (no new traces)",
  skipped_blocked: "Skipped (plan limit)",
};

export const RUN_STATUS_TONE: Record<LoopRunStatus, LoopTone> = {
  pending: "neutral",
  running: "warning",
  succeeded: "ok",
  quiet: "neutral",
  failed: "alert",
  timed_out: "alert",
  skipped_precheck: "neutral",
  skipped_blocked: "warning",
};

/** "Succeeded · 2 findings" for a run that recorded some, the plain label otherwise. */
export function runOutcomeLabel(status: LoopRunStatus, findingCount: number): string {
  if (status === "succeeded" && findingCount > 0) {
    return `Succeeded · ${findingCount} ${findingCount === 1 ? "finding" : "findings"}`;
  }
  return RUN_STATUS_LABEL[status];
}
