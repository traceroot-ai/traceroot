import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { getSignal } from "../ee/signals/index.ts";

const DAY_MS = 86_400_000;

/** A minimal stub signal/db good enough to drive getSignal through hitSeries. */
function stubDb() {
  return {
    signal: {
      findFirst: vi.fn(async () => ({
        id: "a",
        detectorId: "d",
        title: "A",
        reopenSeq: 0,
        mergedIntoId: null,
        rcas: [],
      })),
    },
    signalHit: {
      findMany: vi.fn(async () => []),
      findFirst: vi.fn(async () => null),
    },
    signalStatusEvent: { findMany: vi.fn(async () => []) },
    detector: { findMany: vi.fn(async () => [{ id: "d", name: "Failure" }]) },
    $queryRaw: vi.fn(async () => []),
  };
}

describe("getSignal day-bucket stepping", () => {
  beforeEach(() => vi.restoreAllMocks());
  afterEach(() => vi.restoreAllMocks());

  it("steps day buckets coarser than hourly for a long window", async () => {
    // Spy without replacing the implementation: buckets still compute correctly,
    // we just count how many times the formatter actually ran.
    const spy = vi.spyOn(Intl.DateTimeFormat.prototype, "formatToParts");

    const from = new Date("2026-01-01T00:00:00Z");
    const days = 400;
    const to = new Date(from.getTime() + days * DAY_MS);

    await getSignal(stubDb() as never, {
      projectId: "p",
      signalId: "a",
      from,
      to,
      tz: "UTC",
    });

    // A 1h step (the regressed behavior) would call the formatter on the order
    // of days * 24 (~9600) times for this window. A 12h step calls it on the
    // order of days * 2 (~800) times. Guard against sliding back to hourly.
    expect(spy.mock.calls.length).toBeGreaterThan(days);
    expect(spy.mock.calls.length).toBeLessThan(days * 4);
  });

  it("still lands in every calendar day across a DST transition", async () => {
    // America/New_York springs forward on 2026-03-08, so the local day
    // 2026-03-08 is only 23h long. Window is local midnight to local midnight,
    // 14 calendar days later.
    const from = new Date("2026-03-01T05:00:00Z"); // 2026-03-01T00:00 America/New_York (EST, UTC-5)
    const to = new Date("2026-03-15T04:00:00Z"); // 2026-03-15T00:00 America/New_York (EDT, UTC-4)

    const result = await getSignal(stubDb() as never, {
      projectId: "p",
      signalId: "a",
      from,
      to,
      tz: "America/New_York",
    });

    const expectedDays = Array.from(
      { length: 14 },
      (_, i) => `2026-03-${String(i + 1).padStart(2, "0")}`,
    );
    expect(
      (result as { hitSeries: { bucket: string; hits: number }[] }).hitSeries.map((s) => s.bucket),
    ).toEqual(expectedDays);
  });
});

describe("hour buckets across a DST change", () => {
  beforeEach(() => vi.restoreAllMocks());
  afterEach(() => vi.restoreAllMocks());

  // America/New_York falls back at 2026-11-01 02:00 local EDT -> 01:00 EST, i.e.
  // 2026-11-01 06:00 UTC. The window below (05:00-07:00 UTC) covers both real
  // occurrences of local "01:00".
  const dstFrom = new Date("2026-11-01T05:00:00Z");
  const dstTo = new Date("2026-11-01T07:00:00Z");

  it("keeps the two real hours of a fall-back night as distinct empty buckets", async () => {
    const result = await getSignal(stubDb() as never, {
      projectId: "p",
      signalId: "a",
      from: dstFrom,
      to: dstTo,
      tz: "America/New_York",
    });
    expect((result as { hitSeries: { bucket: string; hits: number }[] }).hitSeries).toEqual([
      { bucket: "2026-11-01T01:00-04:00", hits: 0 }, // 05:00-05:59 UTC, still EDT
      { bucket: "2026-11-01T01:00-05:00", hits: 0 }, // 06:00-06:59 UTC, now EST
    ]);
  });

  it("assigns Postgres hit rows to the right one of the two ambiguous hours", async () => {
    // Shaped like the real query's output: both rows share the same formatted
    // "bucket" label (Postgres can't know they're different hours without the
    // offset), so the offset column is what the merge in hitSeries keys on.
    const db = {
      ...stubDb(),
      $queryRaw: vi.fn(async () => [
        { bucket: "2026-11-01T01:00", offsetMinutes: -240, hits: 3 },
        { bucket: "2026-11-01T01:00", offsetMinutes: -300, hits: 5 },
      ]),
    };
    const result = await getSignal(db as never, {
      projectId: "p",
      signalId: "a",
      from: dstFrom,
      to: dstTo,
      tz: "America/New_York",
    });
    expect((result as { hitSeries: { bucket: string; hits: number }[] }).hitSeries).toEqual([
      { bucket: "2026-11-01T01:00-04:00", hits: 3 },
      { bucket: "2026-11-01T01:00-05:00", hits: 5 },
    ]);
  });

  it("buckets a :30-offset zone (Asia/Kolkata) by local hour, not by UTC hour", async () => {
    // IST is UTC+5:30, so its hour boundaries fall on the UTC half-hour: this window
    // (00:40-01:40 UTC) is local 06:10-07:10 IST, touching local hours 06:00 and 07:00
    // despite sitting inside a single UTC hour-ish span.
    const result = await getSignal(stubDb() as never, {
      projectId: "p",
      signalId: "a",
      from: new Date("2026-06-01T00:40:00Z"),
      to: new Date("2026-06-01T01:40:00Z"),
      tz: "Asia/Kolkata",
    });
    expect(
      (result as { hitSeries: { bucket: string; hits: number }[] }).hitSeries.map((s) => s.bucket),
    ).toEqual(["2026-06-01T06:00+05:30", "2026-06-01T07:00+05:30"]);
  });
});
