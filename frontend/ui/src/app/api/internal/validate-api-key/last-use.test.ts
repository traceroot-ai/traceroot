import { describe, it, expect } from "vitest";
import { shouldRefreshLastUseTime, LAST_USE_TIME_REFRESH_INTERVAL_MS } from "./last-use";

describe("shouldRefreshLastUseTime", () => {
  const now = new Date("2026-01-01T00:00:00.000Z");

  it("refreshes a never-used key (null / undefined lastUseTime)", () => {
    expect(shouldRefreshLastUseTime(null, now)).toBe(true);
    expect(shouldRefreshLastUseTime(undefined, now)).toBe(true);
  });

  it("refreshes when lastUseTime is older than the interval", () => {
    const stale = new Date(now.getTime() - LAST_USE_TIME_REFRESH_INTERVAL_MS - 1);
    expect(shouldRefreshLastUseTime(stale, now)).toBe(true);
  });

  it("refreshes exactly at the interval boundary", () => {
    const atBoundary = new Date(now.getTime() - LAST_USE_TIME_REFRESH_INTERVAL_MS);
    expect(shouldRefreshLastUseTime(atBoundary, now)).toBe(true);
  });

  it("skips when lastUseTime is within the interval", () => {
    const fresh = new Date(now.getTime() - LAST_USE_TIME_REFRESH_INTERVAL_MS + 1);
    expect(shouldRefreshLastUseTime(fresh, now)).toBe(false);
  });
});
