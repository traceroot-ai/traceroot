// Pin a non-UTC timezone BEFORE importing the module under test. The timezone-
// naive parsing bug only manifests when the local zone differs from UTC, so
// without this a UTC CI runner would pass even with the bug present.
// America/Los_Angeles is UTC-7 (PDT) on this date.
process.env.TZ = "America/Los_Angeles";

import { describe, it, expect } from "vitest";

import { parseAsUTC } from "./utils";

// The intended UTC instant for a "2026-06-04T06:37:30" backend timestamp.
const UTC_063730 = Date.UTC(2026, 5, 4, 6, 37, 30);

describe("parseAsUTC", () => {
  it("parses a naive timestamp with microseconds as UTC", () => {
    expect(parseAsUTC("2026-06-04T06:37:30.862000").getTime()).toBe(UTC_063730 + 862);
  });

  it("parses a naive millisecond timestamp as UTC", () => {
    expect(parseAsUTC("2026-06-04T06:37:30.500").getTime()).toBe(UTC_063730 + 500);
  });

  // Regression for the 7h-skew bug: the backend drops fractional seconds when
  // they are zero, so a whole-second timestamp arrives as "...06:37:30". Its
  // trailing "37:30" was mistaken for a "-HH:MM" offset and parsed as local.
  it("parses a whole-second naive timestamp as UTC (not local)", () => {
    expect(parseAsUTC("2026-06-04T06:37:30").getTime()).toBe(UTC_063730);
  });

  // Same failure class one notch coarser: minute-precision has no seconds either.
  it("parses a minute-precision naive timestamp as UTC", () => {
    expect(parseAsUTC("2026-06-04T06:37").getTime()).toBe(Date.UTC(2026, 5, 4, 6, 37, 0));
  });

  it("treats a whole-second naive timestamp identically to the same instant with an explicit Z", () => {
    expect(parseAsUTC("2026-06-04T06:37:30").getTime()).toBe(
      parseAsUTC("2026-06-04T06:37:30Z").getTime(),
    );
  });

  it("respects an explicit Z suffix", () => {
    expect(parseAsUTC("2026-06-04T06:37:30Z").getTime()).toBe(UTC_063730);
  });

  it("respects an explicit negative offset instead of forcing UTC", () => {
    // 06:37:30 at -07:00 is 13:37:30 UTC — must NOT be re-interpreted as UTC.
    expect(parseAsUTC("2026-06-04T06:37:30-07:00").getTime()).toBe(
      Date.UTC(2026, 5, 4, 13, 37, 30),
    );
  });

  it("respects an explicit positive offset", () => {
    // 06:37:30 at +05:30 is 01:07:30 UTC.
    expect(parseAsUTC("2026-06-04T06:37:30+05:30").getTime()).toBe(Date.UTC(2026, 5, 4, 1, 7, 30));
  });

  it("returns a Date instance unchanged", () => {
    const d = new Date("2026-06-04T06:37:30Z");
    expect(parseAsUTC(d)).toBe(d);
  });
});
