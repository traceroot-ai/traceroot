import { describe, expect, it } from "vitest";
import {
  loopScheduleSchema,
  nextRunAt,
  scheduleFromColumns,
  scheduleToColumns,
  type LoopSchedule,
} from "../schedule.ts";

const parse = (input: unknown) => loopScheduleSchema.parse(input);
const iso = (d: Date) => d.toISOString();

describe("loopScheduleSchema", () => {
  it("accepts each kind and canonicalises the timezone", () => {
    expect(parse({ kind: "interval", intervalHours: 6 })).toEqual({
      kind: "interval",
      intervalHours: 6,
    });
    expect(parse({ kind: "daily", hour: 9, timezone: "europe/berlin" })).toEqual({
      kind: "daily",
      hour: 9,
      timezone: "Europe/Berlin",
    });
    expect(parse({ kind: "weekly", weekday: 7, hour: 0, timezone: "UTC" })).toMatchObject({
      weekday: 7,
    });
  });

  it.each([
    [{ kind: "interval", intervalHours: 0 }, "intervalHours"],
    [{ kind: "interval", intervalHours: 25 }, "intervalHours"],
    [{ kind: "interval", intervalHours: 1.5 }, "intervalHours"],
    [{ kind: "daily", hour: 24, timezone: "UTC" }, "hour"],
    [{ kind: "daily", hour: 9, timezone: "Mars/Olympus" }, "timezone"],
    [{ kind: "weekly", weekday: 0, hour: 9, timezone: "UTC" }, "weekday"],
    [{ kind: "cron", expr: "* * * * *" }, "schedule.kind"],
  ])("rejects %j", (input, mention) => {
    const result = loopScheduleSchema.safeParse(input);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues[0].message).toContain(mention);
  });
});

describe("nextRunAt", () => {
  it("counts an interval from the instant given, in whole hours of UTC", () => {
    const s: LoopSchedule = { kind: "interval", intervalHours: 6 };
    expect(iso(nextRunAt(s, new Date("2026-03-29T00:30:00Z")))).toBe("2026-03-29T06:30:00.000Z");
  });

  it("keeps an interval exact across a daylight-saving change (no timezone involved)", () => {
    const s: LoopSchedule = { kind: "interval", intervalHours: 24 };
    const from = new Date("2026-03-28T09:00:00Z");
    expect(iso(nextRunAt(s, from))).toBe("2026-03-29T09:00:00.000Z");
  });

  it("follows the local calendar for a daily schedule across spring-forward", () => {
    const s = parse({ kind: "daily", hour: 9, timezone: "Europe/Berlin" });
    expect(iso(nextRunAt(s, new Date("2026-03-28T08:00:00Z")))).toBe("2026-03-29T07:00:00.000Z");
  });

  it("follows the local calendar for a weekly schedule across fall-back", () => {
    const s = parse({ kind: "weekly", weekday: 1, hour: 9, timezone: "Europe/Berlin" });
    // Monday 09:00 CEST, then Monday 09:00 CET a week later (the clocks went back in between).
    expect(iso(nextRunAt(s, new Date("2026-10-19T07:00:00Z")))).toBe("2026-10-26T08:00:00.000Z");
  });

  it("is strictly after the instant when it falls exactly on a slot", () => {
    const s = parse({ kind: "daily", hour: 9, timezone: "UTC" });
    expect(iso(nextRunAt(s, new Date("2026-06-10T09:00:00Z")))).toBe("2026-06-11T09:00:00.000Z");
  });

  it("keeps 09:00 local on consecutive days across both changes", () => {
    const s = parse({ kind: "daily", hour: 9, timezone: "Europe/Berlin" });
    // Berlin skips 02:00-03:00 on 2026-03-29 and repeats 02:00-03:00 on 2026-10-25.
    const march = nextRunAt(s, new Date("2026-03-27T12:00:00Z"));
    expect([iso(march), iso(nextRunAt(s, march))]).toEqual([
      "2026-03-28T08:00:00.000Z",
      "2026-03-29T07:00:00.000Z",
    ]);
    const october = nextRunAt(s, new Date("2026-10-23T12:00:00Z"));
    expect([iso(october), iso(nextRunAt(s, october))]).toEqual([
      "2026-10-24T07:00:00.000Z",
      "2026-10-25T08:00:00.000Z",
    ]);
  });

  it("lands a weekly schedule on its weekday, 167 hours apart across spring-forward and 169 across fall-back", () => {
    const s = parse({ kind: "weekly", weekday: 1, hour: 9, timezone: "Europe/Berlin" });
    // From a Wednesday to the next Monday.
    expect(iso(nextRunAt(s, new Date("2026-06-10T00:00:00Z")))).toBe("2026-06-15T07:00:00.000Z");
    const hours = (a: Date, b: Date) => (b.getTime() - a.getTime()) / 3_600_000;
    const march = new Date("2026-03-23T08:00:00Z"); // Monday 09:00 CET
    expect(hours(march, nextRunAt(s, march))).toBe(167);
    const october = new Date("2026-10-19T07:00:00Z"); // Monday 09:00 CEST
    expect(hours(october, nextRunAt(s, october))).toBe(169);
  });

  it("runs a repeated local hour once, at its first occurrence", () => {
    // 02:00 happens twice on 2026-10-25 in Berlin; the first is still CEST (UTC+2).
    const s = parse({ kind: "daily", hour: 2, timezone: "Europe/Berlin" });
    expect(iso(nextRunAt(s, new Date("2026-10-24T12:00:00Z")))).toBe("2026-10-25T00:00:00.000Z");
  });

  it("runs a skipped local hour just after the gap", () => {
    // 02:00 never happens on 2026-03-29 in Berlin; the clock reads 03:00 CEST = 01:00Z.
    const s = parse({ kind: "daily", hour: 2, timezone: "Europe/Berlin" });
    expect(iso(nextRunAt(s, new Date("2026-03-28T12:00:00Z")))).toBe("2026-03-29T01:00:00.000Z");
  });
});

describe("schedule columns", () => {
  const cases: LoopSchedule[] = [
    { kind: "interval", intervalHours: 3 },
    { kind: "daily", hour: 9, timezone: "Europe/Berlin" },
    { kind: "weekly", weekday: 3, hour: 14, timezone: "America/New_York" },
  ];

  it.each(cases)("round-trips %j", (schedule) => {
    expect(scheduleFromColumns(scheduleToColumns(schedule))).toEqual(schedule);
  });

  it("nulls the columns a kind does not use", () => {
    expect(scheduleToColumns(cases[0])).toEqual({
      scheduleKind: "interval",
      intervalHours: 3,
      weekday: null,
      hour: null,
      timezone: null,
    });
  });

  it("refuses a stored row that no longer parses", () => {
    expect(() =>
      scheduleFromColumns({
        scheduleKind: "daily",
        intervalHours: null,
        weekday: null,
        hour: null,
        timezone: null,
      }),
    ).toThrow(/invalid/);
  });
});
