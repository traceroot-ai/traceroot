import { describe, expect, it } from "vitest";
import type { LoopSchedule } from "@traceroot/core/loops/pure";
import {
  describeNextRun,
  describeSchedule,
  formatInZone,
  nextRunLabel,
  nextRunTitle,
  shortZoneName,
  pauseDetail,
  runOutcomeLabel,
  runStatusShort,
} from "./loop-display";

const daily: LoopSchedule = { kind: "daily", hour: 9, timezone: "Europe/Berlin" };
const weekly: LoopSchedule = { kind: "weekly", weekday: 1, hour: 8, timezone: "America/New_York" };

describe("describeSchedule", () => {
  it("reads each kind in words", () => {
    expect(describeSchedule({ kind: "interval", intervalHours: 1 })).toBe("Every hour");
    expect(describeSchedule({ kind: "interval", intervalHours: 6 })).toBe("Every 6 hours");
    const winter = new Date("2026-11-12T12:00:00Z");
    expect(describeSchedule(daily, winter)).toBe("Daily at 09:00 (CET)");
    expect(describeSchedule(weekly, winter)).toBe("Mondays at 08:00 (EST)");
    expect(describeSchedule({ kind: "daily", hour: 6, timezone: "UTC" }, winter)).toBe(
      "Daily at 06:00 (UTC)",
    );
  });

  it("names a zone the way people say it, falling back to an offset", () => {
    const summer = new Date("2026-07-01T12:00:00Z");
    expect(shortZoneName("Europe/Berlin", summer)).toBe("CEST");
    expect(shortZoneName("America/Los_Angeles", summer)).toBe("PDT");
    expect(shortZoneName("Asia/Tokyo", summer)).toBe("GMT+9");
  });
});

describe("next run, relative", () => {
  const now = new Date("2026-11-12T12:00:00Z");
  const after = (minutes: number) => new Date(now.getTime() + minutes * 60_000);

  it("counts down in minutes, hours and days", () => {
    expect(nextRunLabel(after(45), now)).toBe("in 45m");
    expect(nextRunLabel(after(200), now)).toBe("in 3h 20m");
    expect(nextRunLabel(after(180), now)).toBe("in 3h");
    expect(nextRunLabel(after(60 * 50), now)).toBe("in 2d");
  });

  it("reads Due now once the time has passed, never a time in the past", () => {
    expect(nextRunLabel(now, now)).toBe("Due now");
    expect(nextRunLabel(after(-5), now)).toBe("Due now");
  });

  it("gives the exact time in the loop's zone, and the viewer's when it differs", () => {
    const at = new Date("2026-11-13T08:00:00Z");
    expect(nextRunTitle(at, "Europe/Berlin", "Europe/Berlin")).toBe("Fri 13 Nov, 09:00 CET");
    expect(nextRunTitle(at, "Europe/Berlin", "America/New_York")).toBe(
      "Fri 13 Nov, 09:00 CET\nFri 13 Nov, 03:00 EST your time",
    );
  });
});

describe("next run in the loop's zone", () => {
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
  it("explains a system pause by its failure streak, and nothing for the rest", () => {
    expect(pauseDetail("paused_by_system", 5)).toContain("5 scheduled runs in a row failed");
    expect(pauseDetail("paused", 0)).toBeUndefined();
    expect(pauseDetail("active", 0)).toBeUndefined();
  });

  it("counts findings only on a succeeded run that recorded some", () => {
    expect(runOutcomeLabel("succeeded", 2)).toBe("Succeeded · 2 findings");
    expect(runOutcomeLabel("succeeded", 1)).toBe("Succeeded · 1 finding");
    expect(runOutcomeLabel("succeeded", 0)).toBe("Succeeded");
    expect(runOutcomeLabel("pending", 0)).toBe("Queued");
    expect(runOutcomeLabel("skipped_blocked", 0)).toBe("Skipped (plan limit)");
    expect(runOutcomeLabel("skipped_paused", 0)).toBe("Skipped (loop paused)");
    expect(runStatusShort("skipped_paused")).toBe("Skipped");
    expect(runOutcomeLabel("skipped_no_traces", 0)).toBe("Skipped (no new traces)");
    expect(runStatusShort("skipped_no_traces")).toBe("Skipped");
  });
});
