import { describe, expect, it } from "vitest";
import {
  ALERT_AGGREGATIONS,
  ALERT_FILTER_FIELDS,
  ALERT_MEASURES_BY_VIEW,
  ALERT_OPERATORS,
  ALERT_RENOTIFY_MAX_MINUTES,
  DEFAULT_ALERT_RENOTIFY,
  DEFAULT_ALERT_RENOTIFY_INTERVAL_MINUTES,
  EMPTY_ALERT_FILTER,
  clampRenotifyInterval,
  getMeasure,
  getValidAggregations,
  isCompleteAlertFilter,
  type AlertFilter,
} from "./rule-model";

describe("rule-model", () => {
  it("declares the ten span measures", () => {
    expect(ALERT_MEASURES_BY_VIEW.SPANS.map((m) => m.label)).toEqual([
      "Count",
      "Trace ID",
      "Latency",
      "Cost",
      "Input tokens",
      "Output tokens",
      "Total tokens",
      "Total tokens per second",
      "Unique user ids",
      "Unique session ids",
    ]);
  });

  it("declares the eleven aggregations and six operators", () => {
    expect(ALERT_AGGREGATIONS).toHaveLength(11);
    expect(ALERT_AGGREGATIONS).not.toContain("histogram");
    expect(ALERT_OPERATORS).toEqual([">", ">=", "<", "<=", "=", "!="]);
  });

  it("gives numeric measures every engine-runnable aggregation", () => {
    // Every aggregation but `count`: the engine reserves that one for its
    // count(*) sentinel, so count of a numeric column is a rule it refuses.
    const runnable = ALERT_AGGREGATIONS.filter((aggregation) => aggregation !== "count");

    for (const id of ["latency", "cost", "total_tokens", "total_tokens_per_second"]) {
      const measure = getMeasure("SPANS", id)!;
      expect(getValidAggregations(measure)).toEqual(runnable);
      expect(getValidAggregations(measure)).not.toContain("count");
    }
  });

  it("gives string measures only uniq — no count, no percentiles", () => {
    // count(some_id) tallies the rows carrying that id, not distinct values, so
    // it would misread on a measure labelled unique.
    for (const id of ["trace_id", "unique_user_ids", "unique_session_ids"]) {
      const measure = getMeasure("SPANS", id)!;
      const valid = getValidAggregations(measure);
      expect(valid).toEqual(["uniq"]);
      expect(valid).not.toContain("p95");
    }
  });

  it("pins Count to the count aggregation", () => {
    expect(getValidAggregations(getMeasure("SPANS", "count")!)).toEqual(["count"]);
  });
});

describe("isCompleteAlertFilter", () => {
  it("treats a row as a predicate only once field, op and value are filled", () => {
    expect(isCompleteAlertFilter({ field: "", op: "", value: "" })).toBe(false);
    expect(isCompleteAlertFilter({ field: "model_name", op: "=", value: "" })).toBe(false);
    expect(isCompleteAlertFilter({ field: "model_name", op: "=", value: "gpt-4o" })).toBe(true);
  });

  it("rejects a keyless metadata row: there is no default map key to fall back on", () => {
    expect(isCompleteAlertFilter({ field: "metadata", op: "=", value: "acme" })).toBe(false);
    expect(isCompleteAlertFilter({ field: "metadata", op: "=", value: "acme", key: "" })).toBe(
      false,
    );
    expect(isCompleteAlertFilter({ field: "metadata", op: "=", value: "acme", key: "  " })).toBe(
      false,
    );
    expect(
      isCompleteAlertFilter({ field: "metadata", op: "=", value: "acme", key: "tenant_id" }),
    ).toBe(true);
  });

  it("does not ask an unkeyed field for a key", () => {
    expect(isCompleteAlertFilter({ field: "status", op: "=", value: "ERROR" })).toBe(true);
  });
});

describe("alert filter fields", () => {
  it("lists metadata last, where the field dropdown renders the extra control", () => {
    expect(ALERT_FILTER_FIELDS[ALERT_FILTER_FIELDS.length - 1]).toBe("metadata");
  });
});

describe("EMPTY_ALERT_FILTER", () => {
  it("refuses a write, so one row's edit cannot become every later row's default", () => {
    const overwrite = () => {
      (EMPTY_ALERT_FILTER as AlertFilter).field = "model_name";
    };
    const extend = () => {
      (EMPTY_ALERT_FILTER as AlertFilter).key = "tenant";
    };

    // Module code is strict, so the write throws rather than passing silently;
    // either way what matters is that the shared row is unchanged afterwards.
    try {
      overwrite();
    } catch {
      /* refused outright */
    }
    try {
      extend();
    } catch {
      /* refused outright */
    }

    expect(EMPTY_ALERT_FILTER).toEqual({ field: "", op: "", value: "" });
    expect("key" in EMPTY_ALERT_FILTER).toBe(false);
  });

  it("still seeds an editable row when spread", () => {
    const row: AlertFilter = { ...EMPTY_ALERT_FILTER, field: "status", op: "=", value: "ERROR" };
    row.value = "OK";

    expect(row).toEqual({ field: "status", op: "=", value: "OK" });
    expect(EMPTY_ALERT_FILTER.value).toBe("");
  });
});

describe("renotify", () => {
  it("defaults to off, so a monitor notifies on transitions only", () => {
    expect(DEFAULT_ALERT_RENOTIFY).toEqual({ mode: "OFF" });
  });

  it("holds every typed interval inside the declared bounds", () => {
    expect(clampRenotifyInterval(30)).toBe(30);
    expect(clampRenotifyInterval(0)).toBe(1);
    expect(clampRenotifyInterval(-5)).toBe(1);
    expect(clampRenotifyInterval(ALERT_RENOTIFY_MAX_MINUTES + 1)).toBe(ALERT_RENOTIFY_MAX_MINUTES);
    // Whole minutes only: the stored schema bounds the interval as an integer.
    expect(clampRenotifyInterval(2.7)).toBe(2);
    // An emptied number input reads as NaN; land on the default rather than
    // holding a value the model says is impossible.
    expect(clampRenotifyInterval(Number.NaN)).toBe(DEFAULT_ALERT_RENOTIFY_INTERVAL_MINUTES);
    expect(ALERT_RENOTIFY_MAX_MINUTES).toBe(60 * 24 * 7);
  });
});
