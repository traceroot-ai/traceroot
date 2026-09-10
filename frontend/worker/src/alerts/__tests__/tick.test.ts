import { describe, it, expect } from "vitest";
import { ALERT_EVALUATION_OFFSET_MS, ALERT_WINDOWS, windowToMs } from "@traceroot/core";
import {
  ALERT_TICK_CRON,
  ALERT_TICK_MS,
  alertWindowStart,
  computeAlertTick,
  floorToMinute,
} from "../tick.js";

describe("floorToMinute", () => {
  it("drops seconds and milliseconds", () => {
    expect(floorToMinute(new Date("2026-08-12T10:37:42.913Z")).toISOString()).toBe(
      "2026-08-12T10:37:00.000Z",
    );
  });

  it("leaves an exact minute boundary alone", () => {
    const boundary = new Date("2026-08-12T10:37:00.000Z");
    expect(floorToMinute(boundary).toISOString()).toBe(boundary.toISOString());
  });

  it("floors down rather than to the nearest minute", () => {
    expect(floorToMinute(new Date("2026-08-12T10:37:59.999Z")).toISOString()).toBe(
      "2026-08-12T10:37:00.000Z",
    );
  });

  it("returns a new Date rather than mutating the input", () => {
    const input = new Date("2026-08-12T10:37:42.913Z");
    const floored = floorToMinute(input);

    expect(floored).not.toBe(input);
    expect(input.toISOString()).toBe("2026-08-12T10:37:42.913Z");
  });
});

describe("computeAlertTick", () => {
  it("runs every minute", () => {
    expect(ALERT_TICK_CRON).toBe("* * * * *");
    expect(ALERT_TICK_MS).toBe(60_000);
  });

  it("anchors the boundary on the floored minute and carries the raw now", () => {
    const now = new Date("2026-08-12T10:37:42.913Z");
    const tick = computeAlertTick(now);

    expect(tick.now).toBe(now);
    expect(tick.boundary.toISOString()).toBe("2026-08-12T10:37:00.000Z");
  });

  it("holds the window end the evaluation offset behind the boundary", () => {
    const tick = computeAlertTick(new Date("2026-08-12T10:37:42.913Z"));

    expect(tick.windowEnd.getTime()).toBe(tick.boundary.getTime() - ALERT_EVALUATION_OFFSET_MS);
    expect(tick.windowEnd.toISOString()).toBe("2026-08-12T10:36:30.000Z");
  });

  it("schedules the next run one minute past the boundary", () => {
    const tick = computeAlertTick(new Date("2026-08-12T10:37:42.913Z"));

    expect(tick.nextRunAt.toISOString()).toBe("2026-08-12T10:38:00.000Z");
    expect(tick.nextRunAt.getTime() - tick.boundary.getTime()).toBe(ALERT_TICK_MS);
  });

  it("produces identical edges anywhere inside the same minute", () => {
    const early = computeAlertTick(new Date("2026-08-12T10:37:00.001Z"));
    const late = computeAlertTick(new Date("2026-08-12T10:37:59.999Z"));

    expect(early.boundary).toEqual(late.boundary);
    expect(early.windowEnd).toEqual(late.windowEnd);
    expect(early.nextRunAt).toEqual(late.nextRunAt);
  });

  it("advances by exactly one minute across consecutive ticks", () => {
    const first = computeAlertTick(new Date("2026-08-12T10:37:12.000Z"));
    const second = computeAlertTick(new Date("2026-08-12T10:38:49.000Z"));

    expect(second.boundary.getTime() - first.boundary.getTime()).toBe(ALERT_TICK_MS);
    expect(second.windowEnd.getTime() - first.windowEnd.getTime()).toBe(ALERT_TICK_MS);
  });
});

describe("alertWindowStart", () => {
  it("subtracts the window from the tick's window end", () => {
    const tick = computeAlertTick(new Date("2026-08-12T10:37:42.913Z"));

    expect(alertWindowStart(tick, "10m").toISOString()).toBe("2026-08-12T10:26:30.000Z");
    expect(alertWindowStart(tick, "1m").toISOString()).toBe("2026-08-12T10:35:30.000Z");
  });

  it("spans exactly the window's duration for every token", () => {
    const tick = computeAlertTick(new Date("2026-08-12T10:37:42.913Z"));

    for (const token of Object.keys(ALERT_WINDOWS) as (keyof typeof ALERT_WINDOWS)[]) {
      const from = alertWindowStart(tick, token);
      expect(tick.windowEnd.getTime() - from.getTime()).toBe(windowToMs(token));
    }
  });

  it("gives two different windows in one tick an identical windowEnd, differing only in from", () => {
    const tick = computeAlertTick(new Date("2026-08-12T10:37:42.913Z"));

    const short = { from: alertWindowStart(tick, "1m"), to: tick.windowEnd };
    const long = { from: alertWindowStart(tick, "2h"), to: tick.windowEnd };

    expect(short.to).toEqual(long.to);
    expect(short.from).not.toEqual(long.from);
    expect(long.from.getTime()).toBeLessThan(short.from.getTime());
  });
});
