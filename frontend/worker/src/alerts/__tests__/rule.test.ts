import { describe, it, expect } from "vitest";
import { ALERT_RENOTIFY_MAX_MINUTES, ALERT_RENOTIFY_MIN_MINUTES } from "@traceroot/core";
import { parseAlertRule, type AlertRowLike } from "../rule.js";

const CHANGED_AT = new Date("2026-08-12T10:00:00.000Z");
const ALERTED_AT = new Date("2026-08-12T10:05:00.000Z");

const VALID_ROW: AlertRowLike = {
  id: "alert-1",
  projectId: "proj-1",
  name: "Checkout error rate",
  view: "SPANS",
  measure: "count",
  aggregation: "count",
  filters: [{ field: "status", op: "=", value: "error" }],
  window: "10m",
  thresholdOperator: ">",
  threshold: 100,
  renotify: { mode: "EVERY", intervalMinutes: 30 },
  noDataMode: "HOLD",
  severity: "ALERT",
  severityChangedAt: CHANGED_AT,
  alertedAt: ALERTED_AT,
};

const rowWith = (overrides: Partial<AlertRowLike>): AlertRowLike => ({
  ...VALID_ROW,
  ...overrides,
});

const filtersOf = (value: unknown): unknown =>
  parseAlertRule(rowWith({ filters: [{ field: "status", op: "=", value }] }));

describe("parseAlertRule — a well-formed row", () => {
  it("returns the rule with every column carried through, the three state ones nested", () => {
    const { severity, severityChangedAt, alertedAt, ...columns } = VALID_ROW;

    expect(parseAlertRule(VALID_ROW)).toEqual({
      ...columns,
      state: { severity, severityChangedAt, alertedAt },
    });
  });

  it("accepts every token the vocabulary allows, and nothing outside it", () => {
    for (const operator of [">", ">=", "<", "<=", "=", "!="]) {
      expect(parseAlertRule(rowWith({ thresholdOperator: operator }))?.thresholdOperator).toBe(
        operator,
      );
    }
    for (const aggregation of ["sum", "avg", "count", "max", "min", "p95", "uniq"]) {
      expect(parseAlertRule(rowWith({ aggregation }))?.aggregation).toBe(aggregation);
    }
    for (const window of ["1m", "5m", "10m", "30m", "1h", "2h"]) {
      expect(parseAlertRule(rowWith({ window }))?.window).toBe(window);
    }
    expect(parseAlertRule(rowWith({ view: "TRACES" }))).toBeNull();
    expect(parseAlertRule(rowWith({ view: "spans" }))).toBeNull();
    expect(parseAlertRule(rowWith({ aggregation: "median" }))).toBeNull();
    expect(parseAlertRule(rowWith({ window: "24h" }))).toBeNull();
    expect(parseAlertRule(rowWith({ thresholdOperator: "==" }))).toBeNull();
  });
});

describe("parseAlertRule — the no-data mode", () => {
  it("carries every mode the vocabulary declares", () => {
    for (const mode of ["HOLD", "ZERO", "NOTIFY"]) {
      expect(parseAlertRule(rowWith({ noDataMode: mode }))?.noDataMode).toBe(mode);
    }
  });

  it("falls back to holding rather than discarding a rule over an unreadable mode", () => {
    // A rule stored by a newer build is still a rule this one can evaluate; the
    // fallback is the reading that decides the least.
    for (const stored of ["", "hold", "IGNORE", "toString"]) {
      expect(parseAlertRule(rowWith({ noDataMode: stored }))?.noDataMode).toBe("HOLD");
    }
  });
});

describe("parseAlertRule — threshold shapes", () => {
  it("reads the shapes a threshold arrives in", () => {
    // Prisma hands back a Decimal, which is neither number nor string.
    expect(parseAlertRule(rowWith({ threshold: { toNumber: () => 12.5 } }))?.threshold).toBe(12.5);
    expect(parseAlertRule(rowWith({ threshold: "42.5" }))?.threshold).toBe(42.5);
    expect(parseAlertRule(rowWith({ threshold: 0 }))?.threshold).toBe(0);
    expect(parseAlertRule(rowWith({ threshold: -1 }))?.threshold).toBe(-1);
  });

  it("returns null for a threshold that is not a finite number", () => {
    const unreadable = [null, undefined, "abc", Number.NaN, Number.POSITIVE_INFINITY, {}, []];
    const decimals = [{ toNumber: () => Number.NaN }, { toNumber: () => "12" }];

    for (const threshold of [...unreadable, ...decimals]) {
      expect(parseAlertRule(rowWith({ threshold }))).toBeNull();
    }
  });
});

describe("parseAlertRule — filters", () => {
  it("accepts the filter shapes the evaluator takes", () => {
    expect(parseAlertRule(rowWith({ filters: null }))?.filters).toEqual([]);
    expect(parseAlertRule(rowWith({ filters: undefined }))?.filters).toEqual([]);
    expect(parseAlertRule(rowWith({ filters: [] }))?.filters).toEqual([]);

    const filters = [
      { field: "metadata", key: "env", op: "=", value: "prod" },
      { field: "service", op: "contains", value: "api" },
      { field: "duration_ms", op: ">", value: 250 },
      { field: "cost", op: "<=", value: 0 },
    ];
    expect(parseAlertRule(rowWith({ filters }))?.filters).toEqual(filters);
  });

  it("discards a rule whose filter value is a set", () => {
    // A set-valued row is what the old write gate allowed and the evaluator
    // never accepted; parsing it would send a spec that fails the whole batch.
    for (const value of [["api", "web"], ["api"], [4], []]) {
      expect(filtersOf(value)).toBeNull();
    }
  });

  it("discards a rule whose filter row is missing a part, or holds a value that is not a scalar", () => {
    expect(parseAlertRule(rowWith({ filters: [{ field: "status", op: "=" }] }))).toBeNull();
    const notFinite = [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY];

    for (const value of [...notFinite, undefined, true, null, {}, { in: ["a"] }]) {
      expect(filtersOf(value)).toBeNull();
    }

    for (const filters of [{}, "[]", 7, true]) {
      expect(parseAlertRule(rowWith({ filters }))).toBeNull();
    }
    expect(parseAlertRule(rowWith({ filters: [{ op: "=", value: "error" }] }))).toBeNull();
    expect(parseAlertRule(rowWith({ filters: [{ field: "status", value: "error" }] }))).toBeNull();
    expect(parseAlertRule(rowWith({ filters: [{ field: 7, op: "=", value: "e" }] }))).toBeNull();
    expect(parseAlertRule(rowWith({ filters: [null] }))).toBeNull();
    expect(
      parseAlertRule(rowWith({ filters: [{ field: "metadata", key: 7, op: "=", value: "p" }] })),
    ).toBeNull();
  });
});

describe("parseAlertRule — renotify", () => {
  it("reads both modes, clamping an out-of-range interval rather than rejecting the rule", () => {
    expect(parseAlertRule(rowWith({ renotify: { mode: "OFF" } }))?.renotify).toEqual({
      mode: "OFF",
    });
    expect(
      parseAlertRule(rowWith({ renotify: { mode: "EVERY", intervalMinutes: "45" } }))?.renotify,
    ).toEqual({ mode: "EVERY", intervalMinutes: 45 });
    expect(
      parseAlertRule(rowWith({ renotify: { mode: "EVERY", intervalMinutes: 0 } }))?.renotify,
    ).toEqual({ mode: "EVERY", intervalMinutes: ALERT_RENOTIFY_MIN_MINUTES });
    expect(
      parseAlertRule(rowWith({ renotify: { mode: "EVERY", intervalMinutes: 1e9 } }))?.renotify,
    ).toEqual({ mode: "EVERY", intervalMinutes: ALERT_RENOTIFY_MAX_MINUTES });
  });

  it("returns null for an unknown mode, or an EVERY with no usable interval", () => {
    const unknownMode = [null, undefined, {}, { mode: "SOMETIMES" }, "OFF", []];

    for (const renotify of [
      ...unknownMode,
      { mode: "EVERY" },
      { mode: "EVERY", intervalMinutes: "soon" },
    ]) {
      expect(parseAlertRule(rowWith({ renotify }))).toBeNull();
    }
  });
});

describe("parseAlertRule — severity degrades instead of discarding", () => {
  it("falls back to UNKNOWN for an unreadable severity while keeping the rule and its clocks", () => {
    for (const severity of ["WARNING", ""]) {
      const rule = parseAlertRule(rowWith({ severity }));

      expect(rule?.id).toBe("alert-1");
      expect(rule?.state).toEqual({
        severity: "UNKNOWN",
        severityChangedAt: CHANGED_AT,
        alertedAt: ALERTED_AT,
      });
    }

    // And a cold-start row keeps its null clocks rather than inventing any.
    const cold = rowWith({ severity: "UNKNOWN", severityChangedAt: null, alertedAt: null });
    expect(parseAlertRule(cold)?.state).toEqual({
      severity: "UNKNOWN",
      severityChangedAt: null,
      alertedAt: null,
    });
  });
});
