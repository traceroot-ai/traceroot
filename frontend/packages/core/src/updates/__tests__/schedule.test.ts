import { describe, expect, it } from "vitest";
import {
  DEFAULT_UPDATE_LIMITS,
  DEFAULT_UPDATE_SCHEDULE,
  parseLimitsInput,
  parseScheduleInput,
} from "../schedule.ts";
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
    [{ timezone: "+01:00" }],
    [{ timezone: "" }],
    [{ enabled: "yes" }],
  ])("rejects %j", (input) => {
    expect(parseScheduleInput(input).ok).toBe(false);
  });

  it.each([
    "Asia/Kolkata",
    "Asia/Calcutta",
    "Europe/Kyiv",
    "Asia/Kathmandu",
    "America/Argentina/Buenos_Aires",
    "Etc/GMT+5",
    "UTC",
  ])("accepts the timezone %s", (timezone) => {
    expect(parseScheduleInput({ timezone }).ok).toBe(true);
  });

  it.each([
    ["utc", "UTC"],
    ["america/new_york", "America/New_York"],
    ["America/New_york", "America/New_York"],
    ["EUROPE/berlin", "Europe/Berlin"],
  ])("saves %s in its canonical spelling %s", (given, canonical) => {
    expect(parseScheduleInput({ timezone: given })).toMatchObject({
      ok: true,
      value: { timezone: canonical },
    });
  });

  it("rejects numeric offsets as zones", () => {
    expect(parseScheduleInput({ timezone: "+01:00" }).ok).toBe(false);
    expect(parseScheduleInput({ timezone: "GMT+1" }).ok).toBe(false);
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

describe("limits", () => {
  it("defaults, and keeps current values for fields left out", () => {
    expect(parseLimitsInput({})).toEqual({ ok: true, value: DEFAULT_UPDATE_LIMITS });
    expect(
      parseLimitsInput({ runTokenCap: 5000 }, { runTokenCap: 9000, monthlySpendCapUsd: 3 }),
    ).toEqual({
      ok: true,
      value: { runTokenCap: 5000, monthlySpendCapUsd: 3 },
    });
  });

  it.each([
    { runTokenCap: 10 },
    { runTokenCap: 1.5 },
    { runTokenCap: 10_000_000 },
    { monthlySpendCapUsd: -1 },
    { monthlySpendCapUsd: "5" },
    { monthlySpendCapUsd: 1e9 },
  ])("rejects %j", (input) => expect(parseLimitsInput(input).ok).toBe(false));

  it("lets the schedule parser pass the limit keys through", () => {
    expect(parseScheduleInput({ frequency: "daily", runTokenCap: 5000 }).ok).toBe(true);
  });
});
