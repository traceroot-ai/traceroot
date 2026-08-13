import { describe, it, expect } from "vitest";
import { ALERT_WINDOWS } from "../constants.ts";
import {
  ALERT_AGGREGATIONS,
  ALERT_FILTER_FIELDS,
  ALERT_FILTER_OPERATORS,
  ALERT_FILTER_OPERATORS_BY_FIELD,
  ALERT_MEASURES_BY_VIEW,
  ALERT_RENOTIFY_MAX_MINUTES,
  ALERT_RENOTIFY_MIN_MINUTES,
  ALERT_SEVERITIES,
  ALERT_STATUSES,
  ALERT_THRESHOLD_OPERATORS,
  ALERT_VIEWS,
  DEFAULT_ALERT_RENOTIFY,
  DEFAULT_ALERT_RENOTIFY_INTERVAL_MINUTES,
  DEFAULT_ALERT_SEVERITY,
  DEFAULT_ALERT_STATUS,
  DEFAULT_ALERT_VIEW,
  KEYED_ALERT_FILTER_FIELDS,
  canonicalizeAlertFilters,
  clampRenotifyInterval,
  getValidAggregations,
  isAlertAggregation,
  isAlertFilterField,
  isAlertFilterOperator,
  isAlertSeverity,
  isAlertStatus,
  isAlertThresholdOperator,
  isAlertView,
  isEvaluableAlertMetric,
  resolveAlertMetricSource,
  windowToMs,
  type AlertFilter,
} from "../alerts.ts";

describe("canonicalizeAlertFilters", () => {
  it("orders rows on field, then op, then key, then value, whatever order they arrived in", () => {
    const rows: AlertFilter[] = [
      { field: "metadata", key: "region", op: "=", value: "us" },
      { field: "metadata", key: "region", op: "=", value: "eu" },
      { field: "metadata", key: "app", op: "=", value: "web" },
      { field: "metadata", key: "app", op: "<", value: "web" },
      { field: "metadata", op: "=", value: "anything" },
      { field: "duration", op: ">", value: 100 },
    ];

    expect(canonicalizeAlertFilters(rows)).toEqual([
      { field: "duration", op: ">", value: 100 },
      { field: "metadata", key: "app", op: "<", value: "web" },
      { field: "metadata", op: "=", value: "anything" },
      { field: "metadata", key: "app", op: "=", value: "web" },
      { field: "metadata", key: "region", op: "=", value: "eu" },
      { field: "metadata", key: "region", op: "=", value: "us" },
    ]);
    // a keyless row sorts ahead of a keyed one sharing its field and op
    expect(canonicalizeAlertFilters([...rows].reverse())).toEqual(canonicalizeAlertFilters(rows));
    expect(canonicalizeAlertFilters([])).toEqual([]);
  });

  it("serializes two orderings of one predicate set to the same bytes", () => {
    const first: AlertFilter[] = [
      { field: "metadata", key: "env", op: "=", value: "prod" },
      { field: "status", op: "=", value: "error" },
    ];
    const second: AlertFilter[] = [first[1], first[0]];

    expect(JSON.stringify(canonicalizeAlertFilters(first))).toBe(
      JSON.stringify(canonicalizeAlertFilters(second)),
    );
    // object keys come out in a fixed order, and an absent key is omitted
    expect(JSON.stringify(canonicalizeAlertFilters(first))).toBe(
      '[{"field":"metadata","key":"env","op":"=","value":"prod"},' +
        '{"field":"status","op":"=","value":"error"}]',
    );
  });

  it("returns fresh rows without touching the input array or the rows inside it", () => {
    const rows: AlertFilter[] = [
      { field: "status", op: "=", value: "error" },
      { field: "service", op: "contains", value: "checkout" },
    ];
    const snapshot = JSON.stringify(rows);
    const result = canonicalizeAlertFilters(rows);

    expect(JSON.stringify(rows)).toBe(snapshot);
    expect(result[0]).not.toBe(rows[1]);
    expect(result[0]).toEqual(rows[1]);
  });
});

describe("clampRenotifyInterval", () => {
  it("passes a legal interval through and clamps to the bounds either side", () => {
    expect(clampRenotifyInterval(ALERT_RENOTIFY_MIN_MINUTES)).toBe(ALERT_RENOTIFY_MIN_MINUTES);
    expect(clampRenotifyInterval(ALERT_RENOTIFY_MAX_MINUTES)).toBe(ALERT_RENOTIFY_MAX_MINUTES);
    expect(clampRenotifyInterval(-500)).toBe(ALERT_RENOTIFY_MIN_MINUTES);
    expect(clampRenotifyInterval(ALERT_RENOTIFY_MAX_MINUTES + 1)).toBe(ALERT_RENOTIFY_MAX_MINUTES);
    // truncated toward zero before clamping
    expect(clampRenotifyInterval(30.9)).toBe(30);
  });

  it("falls back to the default on a non-number, and always lands on a legal interval", () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(clampRenotifyInterval(bad)).toBe(DEFAULT_ALERT_RENOTIFY_INTERVAL_MINUTES);
    }

    for (const input of [Number.NaN, -1, 0, 0.4, 1, 60, 10_080, 10_081, 1e12]) {
      const clamped = clampRenotifyInterval(input);
      expect(Number.isInteger(clamped)).toBe(true);
      expect(clamped).toBeGreaterThanOrEqual(ALERT_RENOTIFY_MIN_MINUTES);
      expect(clamped).toBeLessThanOrEqual(ALERT_RENOTIFY_MAX_MINUTES);
    }
  });
});

describe("alert vocabulary guards", () => {
  it("accepts each declared vocabulary, its own defaults, and nothing adjacent", () => {
    for (const severity of ALERT_SEVERITIES) expect(isAlertSeverity(severity)).toBe(true);
    for (const status of ALERT_STATUSES) expect(isAlertStatus(status)).toBe(true);
    for (const op of ALERT_THRESHOLD_OPERATORS) expect(isAlertThresholdOperator(op)).toBe(true);
    for (const agg of ALERT_AGGREGATIONS) expect(isAlertAggregation(agg)).toBe(true);
    expect(isAlertView(DEFAULT_ALERT_VIEW)).toBe(true);
    expect(isAlertSeverity(DEFAULT_ALERT_SEVERITY)).toBe(true);
    expect(isAlertStatus(DEFAULT_ALERT_STATUS)).toBe(true);
    expect(DEFAULT_ALERT_RENOTIFY).toEqual({ mode: "OFF" });

    // TraceRoot has no warning severity and casing is never coerced
    expect(isAlertSeverity("WARNING")).toBe(false);
    expect(isAlertStatus("OK")).toBe(false);
    expect(isAlertView("spans")).toBe(false);
    expect(isAlertThresholdOperator("==")).toBe(false);
    expect(isAlertAggregation("p100")).toBe(false);
    expect(isAlertView("toString")).toBe(false);
    expect(isAlertAggregation("constructor")).toBe(false);
  });

  it("windowToMs returns the canonical duration for every window token", () => {
    expect(windowToMs("30m")).toBe(1_800_000);
    for (const [token, ms] of Object.entries(ALERT_WINDOWS)) {
      expect(windowToMs(token as keyof typeof ALERT_WINDOWS)).toBe(ms);
    }
  });

  it("isAlertFilterOperator accepts only what the query engine implements", () => {
    expect([...ALERT_FILTER_OPERATORS]).toEqual(["=", "contains"]);
    for (const operator of ALERT_FILTER_OPERATORS) {
      expect(isAlertFilterOperator(operator)).toBe(true);
    }

    // Every field an alert can filter on is a string dimension, so no field declares one.
    for (const operator of ["in", "any of", "!=", ">", ">=", "<", "<=", "CONTAINS", ""]) {
      expect({ operator, accepted: isAlertFilterOperator(operator) }).toEqual({
        operator,
        accepted: false,
      });
    }
  });
});

describe("what the form offers and what the engine can run", () => {
  it("never offers an aggregation the evaluability gate would refuse, for any measure", () => {
    // The single rule these two functions restate; drifted apart, the form offered a blank.
    const disagreements: string[] = [];

    for (const view of ALERT_VIEWS) {
      for (const measure of ALERT_MEASURES_BY_VIEW[view]) {
        const offered = getValidAggregations(measure, view);
        for (const aggregation of ALERT_AGGREGATIONS) {
          const isOffered = offered.includes(aggregation);
          const isEvaluable = isEvaluableAlertMetric(view, measure.id, aggregation);
          if (isOffered !== isEvaluable) {
            disagreements.push(
              `${view}/${measure.id} + ${aggregation}: offered=${isOffered} evaluable=${isEvaluable}`,
            );
          }
        }
      }
    }

    expect(disagreements).toEqual([]);
  });

  it("offers every measure a runnable aggregation, from the vocabulary, in its order", () => {
    // A measure with nothing runnable should not be in the registry at all.
    const problems: string[] = [];

    for (const view of ALERT_VIEWS) {
      for (const measure of ALERT_MEASURES_BY_VIEW[view]) {
        const offered = getValidAggregations(measure, view);
        const inOrder = ALERT_AGGREGATIONS.filter((a) => offered.includes(a));
        if (offered.length === 0) problems.push(`${view}/${measure.id}: nothing runnable`);
        if (offered.join() !== inOrder.join()) problems.push(`${view}/${measure.id}: out of order`);
        // count belongs to the row-count measure, never to a column
        if (measure.type !== "count" && offered.includes("count")) {
          problems.push(`${view}/${measure.id}: offers count on a column`);
        }
      }
    }

    expect(problems).toEqual([]);
  });
});

describe("resolveAlertMetricSource", () => {
  it("resolves every measure in the registry to a view and a field", () => {
    // A registry entry with no source is a rule the evaluator cannot run.
    const unresolved = ALERT_VIEWS.flatMap((view) =>
      ALERT_MEASURES_BY_VIEW[view]
        .map((measure) => ({
          measure: `${view}/${measure.id}`,
          source: resolveAlertMetricSource(
            view,
            measure.id,
            getValidAggregations(measure, view)[0],
          ),
        }))
        .filter(({ source }) => !source?.view || !source.field)
        .map(({ measure }) => measure),
    );
    expect(unresolved).toEqual([]);

    // the unique-id measures read traces, where their columns live
    expect(resolveAlertMetricSource("SPANS", "unique_user_ids", "uniq")).toEqual({
      view: "traces",
      field: "user_id",
    });
    expect(resolveAlertMetricSource("SPANS", "latency", "p95")).toEqual({
      view: "spans",
      field: "duration_ms",
    });
    for (const aggregation of ALERT_AGGREGATIONS) {
      expect(resolveAlertMetricSource("SPANS", "not_a_measure", aggregation)).toBeNull();
    }
  });

  it("drops a traces-routed measure the moment any complete filter is attached", () => {
    // The grain invariance that lets these two read from traces needs an unfiltered count.
    const survived: string[] = [];
    for (const measureId of ["unique_user_ids", "unique_session_ids"]) {
      expect(resolveAlertMetricSource("SPANS", measureId, "uniq", [])).not.toBeNull();

      for (const field of ALERT_FILTER_FIELDS) {
        const filter: AlertFilter = KEYED_ALERT_FILTER_FIELDS.includes(field)
          ? { field, key: "tenant", op: "=", value: "acme" }
          : { field, op: "=", value: "acme" };
        if (resolveAlertMetricSource("SPANS", measureId, "uniq", [filter]) !== null) {
          survived.push(`${measureId} + ${field}`);
        }
      }
    }
    expect(survived).toEqual([]);

    const keyed: AlertFilter[] = [{ field: "metadata", key: "tenant", op: "=", value: "acme" }];
    const incomplete: AlertFilter[] = [{ field: "model_name", op: "=", value: "" }];
    // a spans-routed measure keeps its source under the same filters
    expect(resolveAlertMetricSource("SPANS", "latency", "p95", keyed)).toEqual({
      view: "spans",
      field: "duration_ms",
    });
    expect(resolveAlertMetricSource("SPANS", "unique_user_ids", "uniq", incomplete)).not.toBeNull();
  });
});

describe("the filter field registry", () => {
  it("declares operators for every filterable field and for nothing else", () => {
    // A field on one table and not the other is a dropdown entry the API refuses.
    expect(Object.keys(ALERT_FILTER_OPERATORS_BY_FIELD).sort()).toEqual(
      [...ALERT_FILTER_FIELDS].sort(),
    );
    // and it keys only fields it also declares as filterable
    expect(KEYED_ALERT_FILTER_FIELDS.filter((f) => !isAlertFilterField(f))).toEqual([]);
  });

  it("uses up the whole operator vocabulary across the fields, and nothing outside it", () => {
    // An operator no field declares cannot be expressed by any rule.
    const declared = new Set(Object.values(ALERT_FILTER_OPERATORS_BY_FIELD).flat());
    expect([...declared].sort()).toEqual([...ALERT_FILTER_OPERATORS].sort());

    const undeclared = ALERT_FILTER_FIELDS.flatMap((field) => {
      const operators = ALERT_FILTER_OPERATORS_BY_FIELD[field];
      if (operators.length === 0) return [`${field}: no operators`];
      return operators.filter((op) => !isAlertFilterOperator(op)).map((op) => `${field}: ${op}`);
    });
    expect(undeclared).toEqual([]);
  });
});
