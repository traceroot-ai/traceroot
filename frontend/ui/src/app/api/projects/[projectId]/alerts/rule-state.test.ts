import { afterEach, describe, expect, it, vi } from "vitest";
import { Prisma } from "@prisma/client";
import { DEFAULT_ALERT_SEVERITY, type AlertFilter } from "@traceroot/core";
import {
  alertStateReset,
  hasRuleChanged,
  toRuleSnapshot,
  type AlertRuleSnapshot,
} from "./rule-state";
import type { AlertRow } from "./serialize";

const currentRule: AlertRuleSnapshot = {
  view: "SPANS",
  measure: "latency",
  aggregation: "p95",
  filters: [{ field: "model_name", op: "=", value: "gpt-4o" }],
  window: "10m",
  thresholdOperator: ">",
  threshold: 500,
  noDataMode: "HOLD",
};

function alertRow(overrides: Partial<Record<string, unknown>> = {}): AlertRow {
  return {
    id: "alert-1",
    name: "P95 latency",
    view: "SPANS",
    measure: "latency",
    aggregation: "p95",
    filters: [{ field: "model_name", op: "=", value: "gpt-4o" }],
    window: "10m",
    thresholdOperator: ">",
    threshold: new Prisma.Decimal("500.000"),
    noDataMode: "HOLD",
    renotify: { mode: "OFF" },
    status: "ACTIVE",
    severity: "ALERT",
    severityChangedAt: new Date("2026-08-01T00:00:00.000Z"),
    alertedAt: new Date("2026-08-01T00:00:00.000Z"),
    lastEvaluatedAt: new Date("2026-08-01T00:01:00.000Z"),
    createTime: new Date("2026-07-01T00:00:00.000Z"),
    updateTime: new Date("2026-07-01T00:00:00.000Z"),
    createdBy: "user-1",
    ...overrides,
  } as unknown as AlertRow;
}

/** How the PATCH route shapes its update: every evaluation-bearing field, undefined when untouched. */
function patchUpdate(fields: Partial<AlertRuleSnapshot> = {}): Partial<AlertRuleSnapshot> {
  return {
    view: undefined,
    measure: undefined,
    aggregation: undefined,
    filters: undefined,
    window: undefined,
    thresholdOperator: undefined,
    threshold: undefined,
    noDataMode: undefined,
    ...fields,
  };
}

describe("toRuleSnapshot", () => {
  it("reads the eight evaluation-bearing fields off a stored row", () => {
    expect(toRuleSnapshot(alertRow())).toEqual(currentRule);
  });

  it("does not carry the name, which no evaluation reads", () => {
    expect("name" in toRuleSnapshot(alertRow())).toBe(false);
  });

  it("renders the decimal threshold as a number", () => {
    const snapshot = toRuleSnapshot(alertRow({ threshold: new Prisma.Decimal("0.500") }));

    expect(snapshot.threshold).toBe(0.5);
    expect(typeof snapshot.threshold).toBe("number");
  });
});

describe("hasRuleChanged", () => {
  it("does not reset state for a rename", () => {
    // A name-only PATCH leaves every evaluation-bearing field undefined, so a
    // rename must not void the severity the alert is currently holding.
    expect(hasRuleChanged(currentRule, patchUpdate())).toBe(false);
  });

  it("reports a change for each of the eight evaluation-bearing fields", () => {
    const changes: Partial<AlertRuleSnapshot>[] = [
      { view: "TRACES" },
      { measure: "cost" },
      { aggregation: "p99" },
      { window: "1h" },
      { thresholdOperator: ">=" },
      { threshold: 501 },
      { noDataMode: "NOTIFY" },
      { filters: [{ field: "model_name", op: "=", value: "claude" }] },
    ];

    for (const change of changes) {
      expect(hasRuleChanged(currentRule, patchUpdate(change))).toBe(true);
    }
  });

  it("reports no change when a field is resubmitted with its current value", () => {
    expect(
      hasRuleChanged(
        currentRule,
        patchUpdate({
          view: "SPANS",
          measure: "latency",
          aggregation: "p95",
          window: "10m",
          thresholdOperator: ">",
          threshold: 500,
          noDataMode: "HOLD",
          filters: [{ field: "model_name", op: "=", value: "gpt-4o" }],
        }),
      ),
    ).toBe(false);
  });

  it("resets state for a noDataMode-only edit, whose severity policy the old state was not computed under", () => {
    expect(hasRuleChanged(currentRule, patchUpdate({ noDataMode: "NOTIFY" }))).toBe(true);
    expect(hasRuleChanged(currentRule, patchUpdate({ noDataMode: "HOLD" }))).toBe(false);
  });

  describe("threshold comparison", () => {
    it("compares a decimal-backed threshold as a number, not a string", () => {
      // 500.000 off the column and 500 off the wire are the same threshold.
      const stored = toRuleSnapshot(alertRow({ threshold: new Prisma.Decimal("500.000") }));

      expect(hasRuleChanged(stored, patchUpdate({ threshold: 500 }))).toBe(false);
    });

    it("still catches a genuine fractional difference", () => {
      const stored = toRuleSnapshot(alertRow({ threshold: new Prisma.Decimal("500.000") }));

      expect(hasRuleChanged(stored, patchUpdate({ threshold: 500.5 }))).toBe(true);
    });

    it("treats zero and negative thresholds as values, not absent fields", () => {
      const stored = toRuleSnapshot(alertRow({ threshold: new Prisma.Decimal("0") }));

      expect(hasRuleChanged(stored, patchUpdate({ threshold: 0 }))).toBe(false);
      expect(hasRuleChanged(stored, patchUpdate({ threshold: -1 }))).toBe(true);
    });
  });

  describe("filter comparison", () => {
    it("ignores row order, which canonicalization removes on both sides", () => {
      const a: AlertFilter[] = [
        { field: "model_name", op: "=", value: "gpt-4o" },
        { field: "status", op: "=", value: "error" },
      ];
      const reordered: AlertFilter[] = [a[1], a[0]];

      expect(
        hasRuleChanged({ ...currentRule, filters: a }, patchUpdate({ filters: reordered })),
      ).toBe(false);
    });

    it("reports a change when a filter row is added or removed", () => {
      expect(
        hasRuleChanged(
          currentRule,
          patchUpdate({
            filters: [
              { field: "model_name", op: "=", value: "gpt-4o" },
              { field: "status", op: "=", value: "error" },
            ],
          }),
        ),
      ).toBe(true);
      expect(hasRuleChanged(currentRule, patchUpdate({ filters: [] }))).toBe(true);
    });

    it("reports a change when only a keyed filter's key differs", () => {
      const stored: AlertFilter[] = [{ field: "metadata", key: "tenant", op: "=", value: "acme" }];
      const rekeyed: AlertFilter[] = [{ field: "metadata", key: "region", op: "=", value: "acme" }];

      expect(
        hasRuleChanged({ ...currentRule, filters: stored }, patchUpdate({ filters: rekeyed })),
      ).toBe(true);
    });
  });
});

describe("alertStateReset", () => {
  // The reset is applied on an edit and on a resume, so its clock has to be the
  // clock at that moment. Everything below is measured against a pinned instant.
  const RESET_AT = new Date("2026-08-01T12:00:00.000Z");
  const MINUTE_MS = 60_000;

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns the alert to a cold start", () => {
    vi.useFakeTimers({ now: RESET_AT });

    expect(alertStateReset()).toEqual({
      severity: DEFAULT_ALERT_SEVERITY,
      severityChangedAt: null,
      alertedAt: null,
      lastEvaluatedAt: null,
      nextRunAt: RESET_AT,
      lastClaimedAt: null,
      lastError: null,
      lastErrorAt: null,
      lastNotifyStatus: null,
      lastNotifyError: null,
      lastNotifyAt: null,
    });
  });

  it("leaves status and the rule fields alone", () => {
    const reset = alertStateReset();

    for (const field of ["status", "name", "threshold", "window"]) {
      expect(field in reset).toBe(false);
    }
  });

  // The reset schedules the next run rather than clearing it: a null there
  // sorts last under the scheduler's ordering, which would put an edited or
  // resumed rule behind every rule on the platform.
  describe("the next run it schedules", () => {
    it("moves with the clock instead of freezing at the time the module loaded", () => {
      // A frozen constant would hand every reset for the life of the process
      // the same timestamp: correct for the first edit, months stale by the last.
      vi.useFakeTimers({ now: RESET_AT });
      const first = alertStateReset();

      vi.setSystemTime(new Date(RESET_AT.getTime() + 90 * MINUTE_MS));
      const second = alertStateReset();

      expect(second.nextRunAt.getTime() - first.nextRunAt.getTime()).toBe(90 * MINUTE_MS);
    });
  });

  describe("the object it hands back", () => {
    it("cannot be spoiled for the next caller by the last one", () => {
      const first = alertStateReset();
      first.severity = "ALERT";
      first.nextRunAt = new Date("2000-01-01T00:00:00.000Z");

      const second = alertStateReset();

      expect(second.severity).toBe(DEFAULT_ALERT_SEVERITY);
      expect(second.nextRunAt.getTime()).toBeGreaterThan(first.nextRunAt.getTime());
    });
  });
});
