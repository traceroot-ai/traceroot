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

/** The shape of an IANA name: Area/Location. Rejects numeric offsets such as "+01:00". */
const IANA_SHAPE = /^[A-Za-z_]+(\/[A-Za-z0-9_+-]+){1,2}$/;

/**
 * The canonical spelling of a timezone name, or null when it is not one.
 *
 * `Intl` reads names without regard to case, and the rest of the pipeline reads
 * them with it, so a name is saved in the spelling `Intl` resolves it to
 * ("america/new_york" becomes "America/New_York"). Numeric offsets are not zones.
 */
export function canonicalTimezone(name: unknown): string | null {
  if (typeof name !== "string" || name.trim() === "") return null;
  if (name.toLowerCase() === "utc") return "UTC";
  if (!IANA_SHAPE.test(name)) return null;
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone: name }).resolvedOptions().timeZone;
  } catch {
    return null;
  }
}

export function isValidTimezone(name: string): boolean {
  return canonicalTimezone(name) !== null;
}

export type ScheduleParseResult =
  | { ok: true; value: UpdateScheduleSettings }
  | { ok: false; error: string };

const KNOWN_KEYS = [
  "enabled",
  "frequency",
  "weekday",
  "hour",
  "timezone",
  // Limits are read by parseLimitsInput; the schedule itself ignores them.
  "runTokenCap",
  "monthlySpendCapUsd",
];

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

  const timezone = canonicalTimezone(
    raw.timezone === undefined ? DEFAULT_UPDATE_SCHEDULE.timezone : raw.timezone,
  );
  if (timezone === null) {
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

/** What one project may spend on updates. */
export interface UpdateLimits {
  /** Most tokens one run may use before it is stopped. */
  runTokenCap: number;
  /** Most the project's runs may cost in a calendar month (UTC), in US dollars. */
  monthlySpendCapUsd: number;
}

export const DEFAULT_UPDATE_LIMITS: UpdateLimits = { runTokenCap: 200_000, monthlySpendCapUsd: 20 };
export const RUN_TOKEN_CAP_RANGE = { min: 1_000, max: 5_000_000 } as const;
export const MONTHLY_SPEND_CAP_RANGE = { min: 0, max: 10_000 } as const;

export type LimitsParseResult = { ok: true; value: UpdateLimits } | { ok: false; error: string };

/** Validate the limits in a request; a field left out keeps its current value. */
export function parseLimitsInput(
  input: unknown,
  current: UpdateLimits = DEFAULT_UPDATE_LIMITS,
): LimitsParseResult {
  const raw = (typeof input === "object" && input !== null ? input : {}) as Record<string, unknown>;
  const tokens = raw.runTokenCap === undefined ? current.runTokenCap : raw.runTokenCap;
  if (
    !Number.isInteger(tokens) ||
    (tokens as number) < RUN_TOKEN_CAP_RANGE.min ||
    (tokens as number) > RUN_TOKEN_CAP_RANGE.max
  ) {
    return {
      ok: false,
      error: `runTokenCap must be a whole number from ${RUN_TOKEN_CAP_RANGE.min} to ${RUN_TOKEN_CAP_RANGE.max}.`,
    };
  }
  const spend =
    raw.monthlySpendCapUsd === undefined ? current.monthlySpendCapUsd : raw.monthlySpendCapUsd;
  if (
    typeof spend !== "number" ||
    !Number.isFinite(spend) ||
    spend < MONTHLY_SPEND_CAP_RANGE.min ||
    spend > MONTHLY_SPEND_CAP_RANGE.max
  ) {
    return {
      ok: false,
      error: `monthlySpendCapUsd must be a number from ${MONTHLY_SPEND_CAP_RANGE.min} to ${MONTHLY_SPEND_CAP_RANGE.max}.`,
    };
  }
  return { ok: true, value: { runTokenCap: tokens as number, monthlySpendCapUsd: spend } };
}
