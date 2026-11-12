/** Whether the runtime knows `name` as an IANA timezone. */
export function isValidTimezone(name: unknown): name is string {
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
export function canonicalTimezone(name: unknown): string | null {
  if (!isValidTimezone(name)) return null;
  return new Intl.DateTimeFormat("en-US", { timeZone: name }).resolvedOptions().timeZone;
}
