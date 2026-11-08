/**
 * The schedule a project sets for its background update.
 *
 * Only two cadences exist: daily and weekly. A run never happens more often
 * than daily, so anything finer is rejected here, before it can reach a row.
 * The weekday is ISO numbered (1 = Monday ... 7 = Sunday) and the hour is a
 * wall-clock hour in the schedule's own IANA timezone.
 */

export const UPDATE_FREQUENCIES = ["daily", "weekly"] as const;
export type UpdateFrequency = (typeof UPDATE_FREQUENCIES)[number];

export interface UpdateScheduleSettings {
  enabled: boolean;
  frequency: UpdateFrequency;
  /** ISO weekday, 1 = Monday ... 7 = Sunday. Ignored for a daily schedule. */
  weekday: number;
  /** Local wall-clock hour, 0..23. */
  hour: number;
  /** IANA timezone name, such as "Europe/Berlin". */
  timezone: string;
}

/** What a project gets when it turns updates on without choosing anything. */
export const DEFAULT_UPDATE_SCHEDULE: UpdateScheduleSettings = {
  enabled: true,
  frequency: "weekly",
  weekday: 1,
  hour: 9,
  timezone: "UTC",
};

/** The two presets the settings page offers before "custom". */
export const UPDATE_SCHEDULE_PRESETS: Record<
  UpdateFrequency,
  Pick<UpdateScheduleSettings, "frequency" | "weekday" | "hour">
> = {
  daily: { frequency: "daily", weekday: 1, hour: 9 },
  weekly: { frequency: "weekly", weekday: 1, hour: 9 },
};

/** The shape of an IANA name: Area/Location, each part capitalised. Rejects "utc", "+01:00", "america/new_york". */
const IANA_SHAPE = /^[A-Z][A-Za-z]+(\/[A-Z][A-Za-z0-9_+-]+){1,2}$/;

/**
 * A timezone is valid when it is "UTC" or an IANA-shaped name the runtime knows.
 * The shape rule keeps out the spellings `Intl` also accepts but the rest of the
 * pipeline's timezone database does not: lower-cased names and numeric offsets.
 * Both the old and the new names of a renamed zone ("Asia/Calcutta", "Asia/Kolkata")
 * pass, because browsers differ in which they list.
 */
export function isValidTimezone(name: string): boolean {
  if (typeof name !== "string" || name.trim() === "") return false;
  if (name === "UTC") return true;
  if (!IANA_SHAPE.test(name)) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: name });
    return true;
  } catch {
    return false;
  }
}

export type ScheduleParseResult =
  | { ok: true; value: UpdateScheduleSettings }
  | { ok: false; error: string };

const KNOWN_KEYS = ["enabled", "frequency", "weekday", "hour", "timezone"];

const TOO_FREQUENT =
  "Updates run at most once a day. Choose frequency 'daily' or 'weekly'; anything more frequent is not supported.";

/**
 * Validate a schedule submitted by a client. Missing fields take the defaults,
 * so a client can send only what it changes; an unknown or too-frequent
 * cadence is an error rather than a silent fallback.
 */
export function parseScheduleInput(input: unknown): ScheduleParseResult {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return { ok: false, error: "The schedule must be an object." };
  }
  const raw = input as Record<string, unknown>;

  // A field that expresses a sub-daily interval gets the explanation of the
  // limit; any other key we do not know is refused too, never ignored.
  for (const key of Object.keys(raw)) {
    if (KNOWN_KEYS.includes(key)) continue;
    const isInterval = /every|interval|cron|minute|hour|period/i.test(key);
    return {
      ok: false,
      error: isInterval ? TOO_FREQUENT : `Unknown schedule field "${key}".`,
    };
  }

  const frequency = raw.frequency === undefined ? DEFAULT_UPDATE_SCHEDULE.frequency : raw.frequency;
  if (!(UPDATE_FREQUENCIES as readonly unknown[]).includes(frequency)) {
    return { ok: false, error: TOO_FREQUENT };
  }

  const weekday = raw.weekday === undefined ? DEFAULT_UPDATE_SCHEDULE.weekday : raw.weekday;
  if (!Number.isInteger(weekday) || (weekday as number) < 1 || (weekday as number) > 7) {
    return { ok: false, error: "weekday must be a whole number from 1 (Monday) to 7 (Sunday)." };
  }

  const hour = raw.hour === undefined ? DEFAULT_UPDATE_SCHEDULE.hour : raw.hour;
  if (!Number.isInteger(hour) || (hour as number) < 0 || (hour as number) > 23) {
    return { ok: false, error: "hour must be a whole number from 0 to 23." };
  }

  const timezone = raw.timezone === undefined ? DEFAULT_UPDATE_SCHEDULE.timezone : raw.timezone;
  if (typeof timezone !== "string" || !isValidTimezone(timezone)) {
    return { ok: false, error: "timezone must be a valid IANA timezone name." };
  }

  const enabled = raw.enabled === undefined ? DEFAULT_UPDATE_SCHEDULE.enabled : raw.enabled;
  if (typeof enabled !== "boolean") {
    return { ok: false, error: "enabled must be true or false." };
  }

  return {
    ok: true,
    value: {
      enabled,
      frequency: frequency as UpdateFrequency,
      weekday: weekday as number,
      hour: hour as number,
      timezone,
    },
  };
}
