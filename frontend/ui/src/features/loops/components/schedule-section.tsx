"use client";

import { useMemo } from "react";
import {
  MAX_INTERVAL_HOURS,
  loopScheduleSchema,
  type LoopScheduleInput,
} from "@traceroot/core/loops/pure";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { describeNextRun, hourLabel, weekdayName } from "../loop-display";

/** What the section edits: every field is kept while the kind changes, so flipping back loses nothing. */
export interface ScheduleDraft {
  kind: "interval" | "daily" | "weekly";
  intervalHours: number;
  weekday: number;
  hour: number;
  timezone: string;
}

export const DEFAULT_SCHEDULE_DRAFT: ScheduleDraft = {
  kind: "daily",
  intervalHours: 6,
  weekday: 1,
  hour: 9,
  timezone: "UTC",
};

/** The draft as the route takes it: only the fields its kind uses. */
export function draftToSchedule(draft: ScheduleDraft): LoopScheduleInput {
  switch (draft.kind) {
    case "interval":
      return { kind: "interval", intervalHours: draft.intervalHours };
    case "daily":
      return { kind: "daily", hour: draft.hour, timezone: draft.timezone };
    case "weekly":
      return { kind: "weekly", weekday: draft.weekday, hour: draft.hour, timezone: draft.timezone };
  }
}

/** The first problem with a draft, in the route's own words, or null. */
export function scheduleProblem(draft: ScheduleDraft): string | null {
  const parsed = loopScheduleSchema.safeParse(draftToSchedule(draft));
  return parsed.success ? null : parsed.error.issues[0].message;
}

const INTERVAL_CHOICES = [1, 2, 3, 4, 6, 8, 12, MAX_INTERVAL_HOURS];
const HOURS = Array.from({ length: 24 }, (_, i) => i);
const WEEKDAYS = [1, 2, 3, 4, 5, 6, 7];

/** Every zone the runtime knows, UTC first; a stored zone the list lacks is added so it still shows. */
function timezoneChoices(current: string): string[] {
  const all =
    typeof Intl.supportedValuesOf === "function" ? Intl.supportedValuesOf("timeZone") : [];
  const zones = ["UTC", ...all.filter((z) => z !== "UTC")];
  return zones.includes(current) ? zones : [current, ...zones];
}

interface ScheduleSectionProps {
  value: ScheduleDraft;
  onChange: (value: ScheduleDraft) => void;
  /** The instant the next run is counted from; tests pin it. */
  now?: Date;
}

/**
 * When the Loop runs: every N hours, daily or weekly at an hour in a zone,
 * with the next run shown in that zone so the choice is checkable at a glance.
 */
export function ScheduleSection({ value, onChange, now }: ScheduleSectionProps) {
  const set = (patch: Partial<ScheduleDraft>) => onChange({ ...value, ...patch });
  const zones = useMemo(() => timezoneChoices(value.timezone), [value.timezone]);
  const problem = scheduleProblem(value);
  const parsed = loopScheduleSchema.safeParse(draftToSchedule(value));
  const next = parsed.success ? describeNextRun(parsed.data, now ?? new Date()) : null;

  const field = (label: string, control: React.ReactNode, width = "w-36") => (
    <div className={width}>
      <p className="mb-1.5 text-[12px] text-muted-foreground">{label}</p>
      {control}
    </div>
  );

  return (
    <div className="border border-border">
      <div className="flex h-9 items-center border-b border-border px-4">
        <span className="text-[13px] font-medium text-foreground">Schedule</span>
      </div>
      <div className="p-4">
        <div className="flex flex-wrap items-end gap-3">
          {field(
            "Runs",
            <Select
              value={value.kind}
              onValueChange={(kind) => set({ kind: kind as ScheduleDraft["kind"] })}
            >
              <SelectTrigger aria-label="Schedule kind">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="interval">Every N hours</SelectItem>
                <SelectItem value="daily">Daily</SelectItem>
                <SelectItem value="weekly">Weekly</SelectItem>
              </SelectContent>
            </Select>,
          )}
          {value.kind === "interval" &&
            field(
              "Every",
              <Select
                value={String(value.intervalHours)}
                onValueChange={(h) => set({ intervalHours: Number(h) })}
              >
                <SelectTrigger aria-label="Interval hours">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {INTERVAL_CHOICES.map((h) => (
                    <SelectItem key={h} value={String(h)}>
                      {h === 1 ? "1 hour" : `${h} hours`}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>,
              "w-28",
            )}
          {value.kind === "weekly" &&
            field(
              "On",
              <Select
                value={String(value.weekday)}
                onValueChange={(d) => set({ weekday: Number(d) })}
              >
                <SelectTrigger aria-label="Weekday">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {WEEKDAYS.map((d) => (
                    <SelectItem key={d} value={String(d)}>
                      {weekdayName(d)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>,
            )}
          {value.kind !== "interval" &&
            field(
              "At",
              <Select value={String(value.hour)} onValueChange={(h) => set({ hour: Number(h) })}>
                <SelectTrigger aria-label="Hour">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {HOURS.map((h) => (
                    <SelectItem key={h} value={String(h)}>
                      {hourLabel(h)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>,
              "w-24",
            )}
          {value.kind !== "interval" &&
            field(
              "Timezone",
              <Select value={value.timezone} onValueChange={(timezone) => set({ timezone })}>
                <SelectTrigger aria-label="Timezone">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {zones.map((z) => (
                    <SelectItem key={z} value={z}>
                      {z}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>,
              "w-56",
            )}
        </div>
        <p className="mt-3 text-[12px] text-muted-foreground" data-testid="next-run">
          {problem ? (
            <span className="text-destructive">{problem}</span>
          ) : (
            <>
              Next run: <span className="text-foreground">{next}</span>
              {value.kind === "interval" ? " (counted from now, in UTC)" : ""}
            </>
          )}
        </p>
      </div>
    </div>
  );
}
