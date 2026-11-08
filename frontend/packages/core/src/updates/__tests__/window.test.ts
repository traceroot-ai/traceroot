import { describe, expect, it } from "vitest";
import {
  latestSlotAtOrBefore,
  localToUtc,
  nextSlotAfter,
  previousSlot,
  windowsAt,
  windowsForSlot,
} from "../window.ts";
import type { UpdateScheduleSettings } from "../schedule.ts";

const weekly = (timezone: string, weekday = 1, hour = 9): UpdateScheduleSettings => ({
  enabled: true,
  frequency: "weekly",
  weekday,
  hour,
  timezone,
});
const daily = (timezone: string, hour = 9): UpdateScheduleSettings => ({
  enabled: true,
  frequency: "daily",
  weekday: 1,
  hour,
  timezone,
});
const iso = (d: Date) => d.toISOString();
const hours = (a: Date, b: Date) => (b.getTime() - a.getTime()) / 3_600_000;

describe("slots in UTC", () => {
  it("finds the latest Monday 09:00 at or before now", () => {
    const slot = latestSlotAtOrBefore(weekly("UTC"), new Date("2026-11-04T12:00:00Z"));
    expect(iso(slot)).toBe("2026-11-02T09:00:00.000Z");
  });

  it("treats the slot instant itself as already passed, and one millisecond before as not", () => {
    const at = new Date("2026-11-02T09:00:00.000Z");
    expect(iso(latestSlotAtOrBefore(weekly("UTC"), at))).toBe("2026-11-02T09:00:00.000Z");
    expect(iso(latestSlotAtOrBefore(weekly("UTC"), new Date(at.getTime() - 1)))).toBe(
      "2026-10-26T09:00:00.000Z",
    );
  });

  it("finds the next slot strictly after now", () => {
    const at = new Date("2026-11-02T09:00:00.000Z");
    expect(iso(nextSlotAfter(weekly("UTC"), at))).toBe("2026-11-09T09:00:00.000Z");
    expect(iso(nextSlotAfter(daily("UTC"), at))).toBe("2026-11-03T09:00:00.000Z");
  });

  it("gives a weekly update a 7-day window and compares it with the week before", () => {
    const w = windowsAt(weekly("UTC"), new Date("2026-11-02T09:30:00Z"));
    expect(iso(w.slotAt)).toBe("2026-11-02T09:00:00.000Z");
    expect(iso(w.windowStart)).toBe("2026-10-26T09:00:00.000Z");
    expect(iso(w.windowEnd)).toBe("2026-11-02T09:00:00.000Z");
    expect(iso(w.prevWindowStart)).toBe("2026-10-19T09:00:00.000Z");
    expect(iso(w.prevWindowEnd)).toBe("2026-10-26T09:00:00.000Z");
  });

  it("gives a daily update one day, compared with the same weekday last week", () => {
    const w = windowsAt(daily("UTC"), new Date("2026-11-04T10:00:00Z"));
    expect(iso(w.windowStart)).toBe("2026-11-03T09:00:00.000Z");
    expect(iso(w.windowEnd)).toBe("2026-11-04T09:00:00.000Z");
    expect(iso(w.prevWindowStart)).toBe("2026-10-27T09:00:00.000Z");
    expect(iso(w.prevWindowEnd)).toBe("2026-10-28T09:00:00.000Z");
  });

  it("derives the same windows however late the run starts", () => {
    const a = windowsAt(weekly("UTC"), new Date("2026-11-02T09:00:01Z"));
    const b = windowsAt(weekly("UTC"), new Date("2026-11-08T23:59:59Z"));
    expect(a).toEqual(b);
  });
});

describe("daylight saving", () => {
  it("makes a weekly window 169 hours when the clocks go back inside it", () => {
    // New York left daylight time on 2026-11-01.
    const w = windowsAt(weekly("America/New_York"), new Date("2026-11-02T15:00:00Z"));
    expect(iso(w.windowEnd)).toBe("2026-11-02T14:00:00.000Z"); // 09:00 EST
    expect(iso(w.windowStart)).toBe("2026-10-26T13:00:00.000Z"); // 09:00 EDT
    expect(hours(w.windowStart, w.windowEnd)).toBe(169);
    expect(hours(w.prevWindowStart, w.prevWindowEnd)).toBe(168);
  });

  it("makes a weekly window 167 hours when the clocks go forward inside it", () => {
    // New York entered daylight time on 2026-03-08.
    const w = windowsAt(weekly("America/New_York"), new Date("2026-03-09T15:00:00Z"));
    expect(iso(w.windowEnd)).toBe("2026-03-09T13:00:00.000Z"); // 09:00 EDT
    expect(iso(w.windowStart)).toBe("2026-03-02T14:00:00.000Z"); // 09:00 EST
    expect(hours(w.windowStart, w.windowEnd)).toBe(167);
  });

  it("makes a daily window 25 hours on the day the clocks go back", () => {
    const w = windowsForSlot(daily("America/New_York"), new Date("2026-11-01T14:00:00Z"));
    expect(iso(w.windowStart)).toBe("2026-10-31T13:00:00.000Z");
    expect(hours(w.windowStart, w.windowEnd)).toBe(25);
  });

  it("keeps the hour of day in the local zone on both sides of the change", () => {
    const before = latestSlotAtOrBefore(
      daily("Europe/Berlin", 8),
      new Date("2026-10-24T12:00:00Z"),
    );
    const after = latestSlotAtOrBefore(daily("Europe/Berlin", 8), new Date("2026-10-26T12:00:00Z"));
    expect(iso(before)).toBe("2026-10-24T06:00:00.000Z"); // 08:00 CEST
    expect(iso(after)).toBe("2026-10-26T07:00:00.000Z"); // 08:00 CET
  });

  it("uses the first occurrence of an hour that happens twice", () => {
    const slot = localToUtc({ y: 2026, m: 11, d: 1 }, 1, "America/New_York");
    expect(iso(slot)).toBe("2026-11-01T05:00:00.000Z"); // 01:00 EDT, not 01:00 EST
  });

  it("moves an hour that never happens to just after the gap", () => {
    const slot = localToUtc({ y: 2026, m: 3, d: 8 }, 2, "America/New_York");
    expect(iso(slot)).toBe("2026-03-08T07:00:00.000Z"); // 03:00 EDT
  });

  it("handles a half-hour offset", () => {
    const slot = latestSlotAtOrBefore(daily("Asia/Kolkata", 9), new Date("2026-11-02T10:00:00Z"));
    expect(iso(slot)).toBe("2026-11-02T03:30:00.000Z");
  });

  it("steps back a whole local week across the change", () => {
    const slot = new Date("2026-11-02T14:00:00Z");
    expect(iso(previousSlot(weekly("America/New_York"), slot))).toBe("2026-10-26T13:00:00.000Z");
  });

  it("puts the slot on the local weekday, not the UTC one", () => {
    // Sunday 22:00 in Los Angeles is already Monday in UTC.
    const slot = latestSlotAtOrBefore(
      weekly("America/Los_Angeles", 7, 22),
      new Date("2026-11-10T12:00:00Z"),
    );
    expect(iso(slot)).toBe("2026-11-09T06:00:00.000Z"); // Sunday 2026-11-08 22:00 PST
  });
});

describe("windows are never empty, in any zone", () => {
  const zones = [
    "America/New_York",
    "Europe/Berlin",
    "America/Nuuk",
    "Africa/Cairo",
    "America/Santiago",
    "America/Scoresbysund",
    "Australia/Lord_Howe",
    "Pacific/Apia",
    "Asia/Kolkata",
    "America/Sao_Paulo",
    "Africa/Casablanca",
  ];

  it("keeps every window positive and contiguous across a year of slots", () => {
    for (const timezone of zones) {
      for (const hour of [0, 2, 3, 23]) {
        for (const frequency of ["daily", "weekly"] as const) {
          const schedule = {
            ...(frequency === "daily" ? daily(timezone, hour) : weekly(timezone, 1, hour)),
          };
          let slot = latestSlotAtOrBefore(schedule, new Date("2026-01-01T00:00:00Z"));
          for (let i = 0; i < (frequency === "daily" ? 370 : 56); i += 1) {
            const w = windowsForSlot(schedule, slot);
            const label = `${timezone} ${frequency} ${hour}h ${slot.toISOString()}`;
            expect(w.windowEnd.getTime() - w.windowStart.getTime(), label).toBeGreaterThan(0);
            expect(w.prevWindowEnd.getTime() - w.prevWindowStart.getTime(), label).toBeGreaterThan(
              0,
            );
            expect(w.prevWindowEnd.getTime(), label).toBeLessThanOrEqual(w.windowStart.getTime());
            slot = nextSlotAfter(schedule, slot);
          }
        }
      }
    }
  }, 120_000);

  it("keeps whole days when clocks skip local midnight", () => {
    // Cairo's clocks went forward at 00:00 on 2026-04-24, so midnight did not exist.
    const schedule = daily("Africa/Cairo", 0);
    let slot = latestSlotAtOrBefore(schedule, new Date("2026-04-22T12:00:00Z"));
    const lengths = [] as number[];
    for (let i = 0; i < 5; i += 1) {
      const w = windowsForSlot(schedule, slot);
      lengths.push(hours(w.windowStart, w.windowEnd));
      slot = nextSlotAfter(schedule, slot);
    }
    expect(lengths.every((h) => h >= 23 && h <= 25)).toBe(true);
    const weekly = windowsAt(
      { ...schedule, frequency: "weekly", weekday: 5 },
      new Date("2026-04-25T12:00:00Z"),
    );
    expect(hours(weekly.windowStart, weekly.windowEnd)).toBeGreaterThanOrEqual(167);
    expect(hours(weekly.windowStart, weekly.windowEnd)).toBeLessThanOrEqual(169);
  });

  it("gives the day after a skipped 23:00 a full day, not an empty one", () => {
    // Nuuk skipped 23:00 local on 2026-03-28 when its clocks went forward.
    const schedule = daily("America/Nuuk", 23);
    const slots = [] as Date[];
    let slot = latestSlotAtOrBefore(schedule, new Date("2026-03-27T00:00:00Z"));
    for (let i = 0; i < 5; i += 1) {
      slots.push(slot);
      slot = nextSlotAfter(schedule, slot);
    }
    for (const s of slots) {
      const w = windowsForSlot(schedule, s);
      expect(hours(w.windowStart, w.windowEnd)).toBeGreaterThanOrEqual(23);
      expect(hours(w.windowStart, w.windowEnd)).toBeLessThanOrEqual(25);
    }
  });
});
