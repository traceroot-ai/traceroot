import { describe, expect, it } from "vitest";
import {
  canonicalTimezone,
  isValidTimezone,
  latestSlotAtOrBefore,
  localToUtc,
  nextSlotAfter,
  type SlotSchedule,
} from "../index.ts";

const berlinDaily: SlotSchedule = {
  cadence: "daily",
  weekday: 1,
  hour: 9,
  timezone: "Europe/Berlin",
};
const berlinMonday: SlotSchedule = { ...berlinDaily, cadence: "weekly" };
const iso = (d: Date) => d.toISOString();

describe("timezone", () => {
  it("accepts IANA names and rejects anything else", () => {
    expect(isValidTimezone("Europe/Berlin")).toBe(true);
    expect(isValidTimezone("Mars/Olympus")).toBe(false);
    expect(isValidTimezone("")).toBe(false);
    expect(isValidTimezone(42)).toBe(false);
  });

  it("canonicalises the spelling and returns null for a non-zone", () => {
    expect(canonicalTimezone("europe/berlin")).toBe("Europe/Berlin");
    expect(canonicalTimezone("UTC")).toBe("UTC");
    expect(canonicalTimezone("nope")).toBeNull();
  });
});

describe("daily slots", () => {
  it("finds the next slot after an instant, strictly", () => {
    const at = new Date("2026-06-10T07:00:00Z"); // 09:00 Berlin (CEST) exactly
    expect(iso(nextSlotAfter(berlinDaily, at))).toBe("2026-06-11T07:00:00.000Z");
    expect(iso(latestSlotAtOrBefore(berlinDaily, at))).toBe("2026-06-10T07:00:00.000Z");
  });

  it("keeps 09:00 local across the spring-forward change", () => {
    // Berlin skips 02:00-03:00 on 2026-03-29: the day after is 23 hours long.
    const saturday = nextSlotAfter(berlinDaily, new Date("2026-03-27T12:00:00Z"));
    const sunday = nextSlotAfter(berlinDaily, saturday);
    expect(iso(saturday)).toBe("2026-03-28T08:00:00.000Z");
    expect(iso(sunday)).toBe("2026-03-29T07:00:00.000Z");
  });

  it("keeps 09:00 local across the fall-back change", () => {
    const saturday = nextSlotAfter(berlinDaily, new Date("2026-10-23T12:00:00Z"));
    const sunday = nextSlotAfter(berlinDaily, saturday);
    expect(iso(saturday)).toBe("2026-10-24T07:00:00.000Z");
    expect(iso(sunday)).toBe("2026-10-25T08:00:00.000Z");
  });
});

describe("weekly slots", () => {
  it("lands on the requested weekday", () => {
    const next = nextSlotAfter(berlinMonday, new Date("2026-06-10T00:00:00Z")); // a Wednesday
    expect(iso(next)).toBe("2026-06-15T07:00:00.000Z");
  });

  it("is 167 hours long across spring-forward and 169 across fall-back", () => {
    const hours = (a: Date, b: Date) => (b.getTime() - a.getTime()) / 3_600_000;
    const march = latestSlotAtOrBefore(berlinMonday, new Date("2026-03-23T12:00:00Z"));
    expect(hours(march, nextSlotAfter(berlinMonday, march))).toBe(167);
    const october = latestSlotAtOrBefore(berlinMonday, new Date("2026-10-19T12:00:00Z"));
    expect(hours(october, nextSlotAfter(berlinMonday, october))).toBe(169);
  });

  it("returns the previous week's slot when this week's has not happened yet", () => {
    const at = new Date("2026-06-15T06:59:00Z"); // Monday, a minute before 09:00 Berlin
    expect(iso(latestSlotAtOrBefore(berlinMonday, at))).toBe("2026-06-08T07:00:00.000Z");
  });
});

describe("localToUtc", () => {
  it("resolves a repeated hour to its first occurrence", () => {
    // 02:00 happens twice on 2026-10-25 in Berlin; the first is still CEST (UTC+2).
    expect(iso(localToUtc({ y: 2026, m: 10, d: 25 }, 2, "Europe/Berlin"))).toBe(
      "2026-10-25T00:00:00.000Z",
    );
  });

  it("resolves a skipped hour to just after the gap", () => {
    // 02:00 never happens on 2026-03-29; the clock reads 03:00 CEST = 01:00Z.
    expect(iso(localToUtc({ y: 2026, m: 3, d: 29 }, 2, "Europe/Berlin"))).toBe(
      "2026-03-29T01:00:00.000Z",
    );
  });
});
