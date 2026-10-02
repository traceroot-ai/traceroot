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
