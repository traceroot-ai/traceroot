/**
 * Midnight UTC of the day `at` falls on: the UTC calendar day the onboarding
 * signals count by, as a Postgres DATE column stores it.
 */
export function utcDay(at: Date): Date {
  return new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()));
}
