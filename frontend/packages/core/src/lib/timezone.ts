/**
 * IANA timezone helpers shared by the server and the browser: validating a
 * zone name, its canonical spelling, and its UTC offset at an instant.
 */

/** Whether the runtime (and so Postgres and ClickHouse) knows `name` as an IANA timezone. */
export function isValidTimeZone(name: unknown): name is string {
  if (typeof name !== "string" || name.trim() === "") return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: name });
    return true;
  } catch {
    return false;
  }
}

/**
 * The canonical spelling of a timezone ("europe/berlin" -> "Europe/Berlin"),
 * so one zone is stored one way, or null when the name is not a timezone.
 */
export function canonicalTimeZone(name: unknown): string | null {
  if (!isValidTimeZone(name)) return null;
  return new Intl.DateTimeFormat("en-US", { timeZone: name }).resolvedOptions().timeZone;
}

/**
 * `tz`'s UTC offset at `date`, in minutes east of UTC (negative west). Computed by
 * reading the zone's wall clock at this instant and comparing it to the instant
 * itself, so a DST change elsewhere in the year has no bearing on the answer.
 */
export function tzOffsetMinutes(date: Date, tz: string): number {
  const format = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const part = Object.fromEntries(format.formatToParts(date).map((p) => [p.type, p.value]));
  const asIfUtc = Date.UTC(
    Number(part.year),
    Number(part.month) - 1,
    Number(part.day),
    Number(part.hour),
    Number(part.minute),
    Number(part.second),
  );
  return Math.round((asIfUtc - date.getTime()) / 60_000);
}
