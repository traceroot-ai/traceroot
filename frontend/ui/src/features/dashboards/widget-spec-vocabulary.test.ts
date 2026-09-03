import { describe, expect, it } from "vitest";
import { WidgetSpecSchema, type WidgetSpec } from "./types";
import { validateWidgetSpecVocabulary } from "./widget-spec-vocabulary";

// Enumerations mirror the generated registry snapshot, whose keys are sorted
// (same rendering convention as the public OpenAPI artifact).
const SPANS_MEASURES =
  "cache_read_tokens, cache_write_tokens, cost, count, duration_ms, input_tokens, output_tokens, total_tokens";
const TRACES_MEASURES =
  "cache_read_tokens, cache_write_tokens, cost, count, duration_ms, error_count, input_tokens, output_tokens, total_tokens";
const SPANS_BREAKDOWNS = "environment, model_name, name, span_kind";
const TRACES_FILTER_FIELDS =
  "cache_read_tokens, cache_write_tokens, cost, duration_ms, environment, error_count, input_tokens, name, output_tokens, session_id, total_tokens, user_id";
const SPANS_HISTOGRAMMABLES =
  "cache_read_tokens, cache_write_tokens, cost, duration_ms, input_tokens, output_tokens, total_tokens";
const BREAKDOWN_DISPLAYS = "displays that support a breakdown: line, area, bar, pie, table";

function spec(overrides: Record<string, unknown>): WidgetSpec {
  const parsed = WidgetSpecSchema.safeParse({
    view: "spans",
    metric: { measure: "count", agg: "count" },
    display: { type: "number" },
    ...overrides,
  });
  if (!parsed.success) throw new Error(`fixture spec failed shape parse: ${parsed.error.message}`);
  return parsed.data;
}

function error(s: WidgetSpec): string {
  const result = validateWidgetSpecVocabulary(s);
  if (result.ok) throw new Error("expected a vocabulary error");
  return result.error;
}

describe("validateWidgetSpecVocabulary", () => {
  it("accepts the valid vocabulary, including a spans/model_name breakdown", () => {
    expect(
      validateWidgetSpecVocabulary(
        spec({
          metric: { measure: "cost", agg: "sum" },
          breakdown: "model_name",
          display: { type: "bar" },
        }),
      ),
    ).toEqual({ ok: true });
    expect(validateWidgetSpecVocabulary(spec({}))).toEqual({ ok: true });
  });

  // The four real-world agent-invented specs that create used to accept and
  // the query engine then rejected forever.
  it('rejects measure "spans" on the spans view with the measure vocabulary', () => {
    expect(error(spec({ metric: { measure: "spans", agg: "count" } }))).toBe(
      `unknown measure "spans" for view "spans" — valid measures: ${SPANS_MEASURES}`,
    );
  });

  it('rejects measure "traces" on the traces view with the measure vocabulary', () => {
    expect(error(spec({ view: "traces", metric: { measure: "traces", agg: "count" } }))).toBe(
      `unknown measure "traces" for view "traces" — valid measures: ${TRACES_MEASURES}`,
    );
  });

  it('rejects breakdown "model" with the groupable vocabulary', () => {
    expect(error(spec({ breakdown: "model", display: { type: "bar" } }))).toBe(
      `unknown breakdown "model" for view "spans" — valid breakdowns: ${SPANS_BREAKDOWNS}`,
    );
  });

  it('rejects filter field "errors" with the filterable vocabulary', () => {
    expect(
      error(
        spec({
          view: "traces",
          filters: [{ field: "errors", op: ">", value: 0 }],
        }),
      ),
    ).toBe(
      `unknown filter field "errors" for view "traces" — valid filter fields: ${TRACES_FILTER_FIELDS}`,
    );
  });

  it("rejects a dimension used as a measure as unknown", () => {
    // "name" exists on spans but has no aggregations — it is not a measure.
    expect(error(spec({ metric: { measure: "name", agg: "count" } }))).toBe(
      `unknown measure "name" for view "spans" — valid measures: ${SPANS_MEASURES}`,
    );
  });

  it("rejects an agg outside the measure's list (count sentinel only counts)", () => {
    expect(error(spec({ metric: { measure: "count", agg: "sum" } }))).toBe(
      'agg "sum" not allowed for measure "count" on view "spans" — valid aggs: count',
    );
    expect(error(spec({ metric: { measure: "cost", agg: "count" } }))).toBe(
      'agg "count" not allowed for measure "cost" on view "spans" — valid aggs: sum, avg, min, max, p50, p95, p99',
    );
  });

  it("rejects a non-groupable existing field as breakdown", () => {
    // "status" is filterable on spans but deliberately not groupable.
    expect(error(spec({ breakdown: "status", display: { type: "bar" } }))).toBe(
      `breakdown "status" is not groupable on view "spans" — valid breakdowns: ${SPANS_BREAKDOWNS}`,
    );
  });

  it("rejects a filter op outside the field's list", () => {
    expect(error(spec({ filters: [{ field: "name", op: ">", value: "x" }] }))).toBe(
      'filter op ">" not allowed for field "name" on view "spans" — valid ops: =, contains',
    );
  });

  it("mirrors the query compiler's float() coercion for number-field filter values", () => {
    // Numeric strings coerce (the compiler applies float(value)) — accepted.
    for (const value of ["500", " 1.5 ", ".5", "5.", "1e3", "1_000", "inf", "NaN", "+2"]) {
      expect(
        validateWidgetSpecVocabulary(spec({ filters: [{ field: "duration_ms", op: ">", value }] })),
      ).toEqual({ ok: true });
    }
    // Anything float() raises on is rejected.
    for (const value of ["fast", "0x10", "1..2", "1_", "e3"]) {
      expect(error(spec({ filters: [{ field: "duration_ms", op: ">", value }] }))).toBe(
        `filter value "${value}" for field "duration_ms" on view "spans" must be numeric`,
      );
    }
  });

  it("accepts a number value on a string field, as the compiler does", () => {
    expect(
      validateWidgetSpecVocabulary(spec({ filters: [{ field: "name", op: "=", value: 5 }] })),
    ).toEqual({ ok: true });
  });

  // Registry rows were looked up by indexing the snapshot object, so a name
  // inherited from Object.prototype resolved to something truthy and the next
  // property access threw — a 500 on every write path instead of the normal
  // "unknown X" reply the caller can correct from.
  it.each(["__proto__", "toString", "constructor", "hasOwnProperty"])(
    'rejects inherited object property "%s" as a measure',
    (name) => {
      expect(error(spec({ metric: { measure: name, agg: "count" } }))).toBe(
        `unknown measure "${name}" for view "spans" — valid measures: ${SPANS_MEASURES}`,
      );
    },
  );

  it.each(["__proto__", "toString", "constructor"])(
    'rejects inherited object property "%s" as a breakdown',
    (name) => {
      expect(error(spec({ breakdown: name, display: { type: "bar" } }))).toBe(
        `unknown breakdown "${name}" for view "spans" — valid breakdowns: ${SPANS_BREAKDOWNS}`,
      );
    },
  );

  it.each(["__proto__", "toString", "constructor"])(
    'rejects inherited object property "%s" as a filter field',
    (name) => {
      expect(error(spec({ view: "traces", filters: [{ field: name, op: "=", value: "x" }] }))).toBe(
        `unknown filter field "${name}" for view "traces" — ` +
          `valid filter fields: ${TRACES_FILTER_FIELDS}`,
      );
    },
  );

  it('rejects inherited object property "toString" as a view', () => {
    expect(error({ ...spec({}), view: "toString" } as unknown as WidgetSpec)).toBe(
      'unknown view "toString" — valid views: spans, traces',
    );
  });

  it("rejects a numeric filter value carrying a zero-width no-break space", () => {
    // JS trim() strips U+FEFF but Python's float() does not, so accepting it
    // here would store a widget the query engine refuses on every render.
    expect(error(spec({ filters: [{ field: "duration_ms", op: ">", value: "\ufeff500" }] }))).toBe(
      'filter value "\ufeff500" for field "duration_ms" on view "spans" must be numeric',
    );
    expect(error(spec({ filters: [{ field: "duration_ms", op: ">", value: "500\ufeff" }] }))).toBe(
      'filter value "500\ufeff" for field "duration_ms" on view "spans" must be numeric',
    );
  });

  it("rejects a breakdown on the displays that cannot express one", () => {
    expect(error(spec({ breakdown: "model_name", display: { type: "number" } }))).toBe(
      `display "number" does not support a breakdown dimension — ${BREAKDOWN_DISPLAYS}`,
    );
    expect(
      error(
        spec({
          metric: { measure: "duration_ms", agg: "p95" },
          breakdown: "model_name",
          display: { type: "histogram" },
        }),
      ),
    ).toBe(`display "histogram" does not support a breakdown dimension — ${BREAKDOWN_DISPLAYS}`);
  });

  it("reports the display before the breakdown vocabulary, as the compiler does", () => {
    // The compiler rejects the display/breakdown pairing before it ever
    // resolves the breakdown field, so an unknown name is beside the point.
    expect(error(spec({ breakdown: "model", display: { type: "number" } }))).toBe(
      `display "number" does not support a breakdown dimension — ${BREAKDOWN_DISPLAYS}`,
    );
  });

  it("accepts a breakdown on every display the compiler groups by", () => {
    for (const type of ["line", "area", "bar", "pie", "table"] as const) {
      expect(
        validateWidgetSpecVocabulary(spec({ breakdown: "model_name", display: { type } })),
      ).toEqual({ ok: true });
    }
  });

  it("accepts number and histogram displays without a breakdown", () => {
    expect(validateWidgetSpecVocabulary(spec({ display: { type: "number" } }))).toEqual({
      ok: true,
    });
    expect(
      validateWidgetSpecVocabulary(
        spec({ metric: { measure: "duration_ms", agg: "p95" }, display: { type: "histogram" } }),
      ),
    ).toEqual({ ok: true });
  });

  it("gates histogram on the histogrammable flag", () => {
    expect(error(spec({ display: { type: "histogram" } }))).toBe(
      `measure "count" cannot be histogrammed on view "spans" — histogrammable measures: ${SPANS_HISTOGRAMMABLES}`,
    );
    expect(
      validateWidgetSpecVocabulary(
        spec({ metric: { measure: "duration_ms", agg: "p95" }, display: { type: "histogram" } }),
      ),
    ).toEqual({ ok: true });
  });
});
