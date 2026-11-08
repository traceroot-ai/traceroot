/**
 * A clock the update code reads instead of `new Date()`, so a test or a seeded
 * run can freeze "now" and get the same window boundaries every time.
 */
export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };

export function frozenClock(at: Date | string): Clock {
  const instant = typeof at === "string" ? new Date(at) : new Date(at.getTime());
  if (Number.isNaN(instant.getTime())) throw new Error(`Cannot freeze the clock at "${at}".`);
  return { now: () => new Date(instant.getTime()) };
}
