import registrySnapshot from "./widget-registry.generated.json";
import { BREAKDOWN_UNSUPPORTED_DISPLAYS, DISPLAY_TYPES } from "./types";
import type { WidgetSpec, WidgetSchemaField } from "./types";

/**
 * Semantic validation of a shape-valid query widget spec against the widget
 * field registry snapshot (widget-registry.generated.json, regenerated with
 * scripts/sync_public_openapi.py). The zod WidgetSpecSchema checks structure;
 * this layer checks vocabulary — that every referenced field actually exists
 * on the view with the referenced capability — mirroring the SQL compiler's
 * registry rules so a widget that creates can never 4xx forever at query time.
 * Every error enumerates the valid options so callers (agent, CLI, API users)
 * can self-correct.
 */

type RegistryView = { fields: Record<string, WidgetSchemaField> };

const REGISTRY = registrySnapshot as Record<string, RegistryView>;

export type VocabularyResult = { ok: true } | { ok: false; error: string };

// The SQL compiler coerces number-field filter values with Python's float():
// numeric strings are accepted — including inf/infinity/nan spellings,
// underscore digit grouping, exponents, and surrounding whitespace — and
// anything else raises. Mirror that acceptance exactly, so create-time
// validation is neither stricter nor looser than the query engine.
const DIGITS = String.raw`\d(?:_?\d)*`;
const COMPILER_FLOAT_RE = new RegExp(
  `^[+-]?(?:inf(?:inity)?|nan|(?:${DIGITS}(?:\\.(?:${DIGITS})?)?|\\.${DIGITS})(?:[eE][+-]?${DIGITS})?)$`,
  "i",
);

const BREAKDOWN_DISPLAYS = DISPLAY_TYPES.filter(
  (type) => !BREAKDOWN_UNSUPPORTED_DISPLAYS.has(type),
).join(", ");

const names = (
  fields: Record<string, WidgetSchemaField>,
  keep: (f: WidgetSchemaField) => boolean,
) =>
  Object.keys(fields)
    .filter((name) => keep(fields[name]))
    .join(", ");

export function validateWidgetSpecVocabulary(spec: WidgetSpec): VocabularyResult {
  const view = REGISTRY[spec.view];
  if (!view) {
    // WidgetSpecSchema pins the view enum already; fail closed if they drift.
    return {
      ok: false,
      error: `unknown view "${spec.view}" — valid views: ${Object.keys(REGISTRY).join(", ")}`,
    };
  }
  const fields = view.fields;

  const measure = fields[spec.metric.measure];
  if (!measure || measure.aggs.length === 0) {
    return {
      ok: false,
      error:
        `unknown measure "${spec.metric.measure}" for view "${spec.view}" — ` +
        `valid measures: ${names(fields, (f) => f.aggs.length > 0)}`,
    };
  }
  if (!measure.aggs.includes(spec.metric.agg)) {
    return {
      ok: false,
      error:
        `agg "${spec.metric.agg}" not allowed for measure "${spec.metric.measure}" on view ` +
        `"${spec.view}" — valid aggs: ${measure.aggs.join(", ")}`,
    };
  }

  if (spec.breakdown !== null) {
    // The compiler settles the display/breakdown pairing before it resolves
    // the breakdown field, so this precedes the vocabulary checks below.
    if (BREAKDOWN_UNSUPPORTED_DISPLAYS.has(spec.display.type)) {
      return {
        ok: false,
        error:
          `display "${spec.display.type}" does not support a breakdown dimension — ` +
          `displays that support a breakdown: ${BREAKDOWN_DISPLAYS}`,
      };
    }
    const breakdown = fields[spec.breakdown];
    const valid = `valid breakdowns: ${names(fields, (f) => f.groupable)}`;
    if (!breakdown) {
      return {
        ok: false,
        error: `unknown breakdown "${spec.breakdown}" for view "${spec.view}" — ${valid}`,
      };
    }
    if (!breakdown.groupable) {
      return {
        ok: false,
        error: `breakdown "${spec.breakdown}" is not groupable on view "${spec.view}" — ${valid}`,
      };
    }
  }

  for (const filter of spec.filters) {
    const field = fields[filter.field];
    if (!field || field.filterOps.length === 0) {
      return {
        ok: false,
        error:
          `unknown filter field "${filter.field}" for view "${spec.view}" — ` +
          `valid filter fields: ${names(fields, (f) => f.filterOps.length > 0)}`,
      };
    }
    if (!field.filterOps.includes(filter.op)) {
      return {
        ok: false,
        error:
          `filter op "${filter.op}" not allowed for field "${filter.field}" on view ` +
          `"${spec.view}" — valid ops: ${field.filterOps.join(", ")}`,
      };
    }
    if (
      field.type === "number" &&
      typeof filter.value === "string" &&
      !COMPILER_FLOAT_RE.test(filter.value.trim())
    ) {
      return {
        ok: false,
        error:
          `filter value "${filter.value}" for field "${filter.field}" on view ` +
          `"${spec.view}" must be numeric`,
      };
    }
  }

  // Absent flag means histogrammable (older cached schemas), matching the
  // WidgetSchemaField contract; the generated snapshot always carries it.
  if (spec.display.type === "histogram" && measure.histogrammable === false) {
    return {
      ok: false,
      error:
        `measure "${spec.metric.measure}" cannot be histogrammed on view "${spec.view}" — ` +
        `histogrammable measures: ${names(fields, (f) => f.histogrammable !== false)}`,
    };
  }

  return { ok: true };
}
