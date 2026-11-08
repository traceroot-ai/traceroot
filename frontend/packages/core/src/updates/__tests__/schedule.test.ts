import { describe, expect, it } from "vitest";
import { DEFAULT_UPDATE_SCHEDULE, parseScheduleInput } from "../schedule.ts";
import { frozenClock } from "../clock.ts";

describe("parseScheduleInput", () => {
  it("defaults to weekly, Monday 09:00", () => {
    const parsed = parseScheduleInput({});
    expect(parsed).toEqual({ ok: true, value: DEFAULT_UPDATE_SCHEDULE });
    expect(DEFAULT_UPDATE_SCHEDULE).toMatchObject({ frequency: "weekly", weekday: 1, hour: 9 });
  });

  it("accepts the daily preset and a custom day, hour and timezone", () => {
    expect(
      parseScheduleInput({ frequency: "daily", hour: 7, timezone: "Europe/Berlin" }),
    ).toMatchObject({
      ok: true,
      value: { frequency: "daily", hour: 7, timezone: "Europe/Berlin" },
    });
    expect(parseScheduleInput({ frequency: "weekly", weekday: 5, hour: 17 })).toMatchObject({
      ok: true,
      value: { weekday: 5, hour: 17 },
    });
  });

  it.each(["hourly", "every_6_hours", "continuous", "minutely", "", null, 24])(
    "rejects the frequency %j as more frequent than daily or unknown",
    (frequency) => {
      const parsed = parseScheduleInput({ frequency });
      expect(parsed.ok).toBe(false);
      expect(parsed).toMatchObject({ error: expect.stringContaining("once a day") });
    },
  );

  it.each([{ everyHours: 6 }, { intervalMinutes: 30 }, { cron: "*/10 * * * *" }])(
    "rejects a sub-daily interval field %j",
    (extra) => {
      expect(parseScheduleInput({ frequency: "daily", ...extra }).ok).toBe(false);
    },
  );

  it.each([{ interval: "1h" }, { period: "hourly" }, { whatever: 1 }])(
    "rejects the unknown field %j instead of ignoring it",
    (extra) => {
      expect(parseScheduleInput({ frequency: "daily", ...extra }).ok).toBe(false);
    },
  );

  it.each([
    [{ weekday: 0 }],
    [{ weekday: 8 }],
    [{ weekday: 1.5 }],
    [{ hour: 24 }],
    [{ hour: -1 }],
    [{ hour: "9" }],
    [{ timezone: "Mars/Olympus" }],
    [{ timezone: "" }],
    [{ enabled: "yes" }],
  ])("rejects %j", (input) => {
    expect(parseScheduleInput(input).ok).toBe(false);
  });

  it("rejects a non-object", () => {
    expect(parseScheduleInput(null).ok).toBe(false);
    expect(parseScheduleInput([]).ok).toBe(false);
  });
});

describe("frozenClock", () => {
  it("returns the same instant every time and a copy of it", () => {
    const clock = frozenClock("2026-11-02T09:30:00Z");
    const first = clock.now();
    first.setUTCFullYear(1999);
    expect(clock.now().toISOString()).toBe("2026-11-02T09:30:00.000Z");
  });

  it("refuses an unreadable instant", () => {
    expect(() => frozenClock("not a date")).toThrow();
  });
});
