// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import {
  isStillPendingGrouping,
  traceSignalsPollDelay,
  type DetectorSignalSetting,
  type IdentifiedTraceRun,
} from "./hooks";

// New tests for the S5 fix: TraceDetectorsTab's "Pending" status used to
// never refetch, so it could stay stale until the page itself reloaded.
// These cover the two pure pieces useTraceSignals' refetchInterval is built
// from, the same way rcaInProgress is tested for useSignal's polling.

describe("isStillPendingGrouping", () => {
  const run: IdentifiedTraceRun = {
    runId: "r1",
    detectorId: "d1",
    timestamp: "2026-06-01T00:00:00",
  };
  const on: DetectorSignalSetting = {
    id: "d1",
    enableSignals: true,
    signalsEnabledAt: "2026-06-01T00:00:00Z",
  };

  it("is pending: no hit yet, detector groups, enabled before the run, deployment groups at all", () => {
    expect(isStillPendingGrouping(run, new Set(), on, true)).toBe(true);
  });

  it("is not pending once a hit for the run has arrived", () => {
    expect(isStillPendingGrouping(run, new Set(["r1"]), on, true)).toBe(false);
  });

  it("is not pending (Disabled) when the detector's grouping is off", () => {
    expect(isStillPendingGrouping(run, new Set(), { ...on, enableSignals: false }, true)).toBe(
      false,
    );
  });

  it("is not pending (Disabled) when the run happened before grouping was enabled", () => {
    const early = { ...run, timestamp: "2026-05-31T23:59:59" };
    expect(isStillPendingGrouping(early, new Set(), on, true)).toBe(false);
  });

  it("is not pending (Disabled) when the deployment does not group hits at all", () => {
    expect(isStillPendingGrouping(run, new Set(), on, false)).toBe(false);
  });

  it("is not pending (—) when the run's detector has no signals setting", () => {
    expect(isStillPendingGrouping(run, new Set(), undefined, true)).toBe(false);
  });
});

describe("traceSignalsPollDelay", () => {
  const now = Date.parse("2026-06-01T00:10:00Z");

  it("does not poll when nothing is pending", () => {
    expect(traceSignalsPollDelay(null, now)).toBe(false);
  });

  it("polls at the normal cadence within the ~10 minute bound", () => {
    const pendingSince = now - 5 * 60 * 1000;
    expect(traceSignalsPollDelay(pendingSince, now)).toBe(10_000);
  });

  it("stops polling once a hit has been pending for about ten minutes", () => {
    const pendingSince = now - 10 * 60 * 1000;
    expect(traceSignalsPollDelay(pendingSince, now)).toBe(false);
  });
});
