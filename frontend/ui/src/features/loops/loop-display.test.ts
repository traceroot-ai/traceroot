import { describe, expect, it } from "vitest";
import type { LoopSchedule } from "@traceroot/core/loops/pure";
import {
  describeNextRun,
  describeSchedule,
  formatInZone,
  pauseDetail,
  runOutcomeLabel,
} from "./loop-display";

const daily: LoopSchedule = { kind: "daily", hour: 9, timezone: "Europe/Berlin" };
const weekly: LoopSchedule = { kind: "weekly", weekday: 1, hour: 8, timezone: "America/New_York" };

describe("describeSchedule", () => {
  it("reads each kind in words", () => {
    expect(describeSchedule({ kind: "interval", intervalHours: 1 })).toBe("Every hour");
    expect(describeSchedule({ kind: "interval", intervalHours: 6 })).toBe("Every 6 hours");
    expect(describeSchedule(daily)).toBe("Daily at 09:00 Europe/Berlin");
    expect(describeSchedule(weekly)).toBe("Mondays at 08:00 America/New_York");
  });
});

describe("next run in the Loop's zone", () => {
  it("shows a daily run at the local hour, with the zone's own name", () => {
    expect(describeNextRun(daily, new Date("2026-11-11T12:00:00Z"))).toBe("Thu 12 Nov, 09:00 CET");
  });

  it("follows daylight-saving time: 09:00 stays 09:00 local either side of the change", () => {
    expect(describeNextRun(daily, new Date("2026-03-28T12:00:00Z"))).toBe("Sun 29 Mar, 09:00 CEST");
  });

  it("shows an interval in UTC", () => {
    expect(
      describeNextRun({ kind: "interval", intervalHours: 6 }, new Date("2026-11-11T00:30:00Z")),
    ).toBe("Wed 11 Nov, 06:30 UTC");
  });

  it("formats an instant in a given zone", () => {
    expect(formatInZone(new Date("2026-06-10T07:00:00Z"), "Europe/Berlin")).toBe(
      "Wed 10 Jun, 09:00 CEST",
    );
  });
});

describe("status and outcome wording", () => {
  it("explains a system pause by its reason and streak, and nothing for the rest", () => {
    expect(pauseDetail("paused_by_system", "failures", 5)).toContain(
      "5 scheduled runs in a row failed",
    );
    expect(pauseDetail("paused", null, 0)).toBeUndefined();
    expect(pauseDetail("active", null, 0)).toBeUndefined();
  });

  it("counts findings only on a succeeded run that recorded some", () => {
    expect(runOutcomeLabel("succeeded", 2)).toBe("Succeeded · 2 findings");
    expect(runOutcomeLabel("succeeded", 1)).toBe("Succeeded · 1 finding");
    expect(runOutcomeLabel("succeeded", 0)).toBe("Succeeded");
    expect(runOutcomeLabel("pending", 0)).toBe("Queued");
    expect(runOutcomeLabel("skipped_blocked", 0)).toBe("Skipped (plan limit)");
  });
});
