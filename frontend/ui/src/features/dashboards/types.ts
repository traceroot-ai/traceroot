import { z } from "zod";

export const DISPLAY_TYPES = [
  "line",
  "area",
  "bar",
  "pie",
  "number",
  "table",
  "histogram",
] as const;
export type DisplayType = (typeof DISPLAY_TYPES)[number];

// Enforced in the create dialog and by the dashboard API routes; sized so a
// full-length name stays visible in the create dialog's input without
// horizontal scrolling. Long names also display truncated in the tabs.
export const DASHBOARD_NAME_MAX = 50;
// Widget titles and dashboard descriptions are also route-enforced: without a
// cap one member can persist arbitrarily large strings that every dashboard
// read then ships to all project members.
export const WIDGET_TITLE_MAX = 100;
export const DASHBOARD_DESCRIPTION_MAX = 500;

export const AGGS = ["count", "sum", "avg", "min", "max", "p50", "p95", "p99"] as const;

export const WidgetFilterSchema = z.object({
  field: z.string().min(1),
  op: z.enum(["=", "!=", "contains", ">", ">=", "<", "<="]),
  // min(1): a filter whose value was never picked (the builder's rows start
  // at "") must keep the spec incomplete, not save a widget that silently
  // matches only empty-valued rows.
  value: z.union([z.string().min(1), z.number()]),
});

// Pie and bar plot one mark per category — without a breakdown dimension the
// query collapses to a single unlabeled datum and there is nothing to chart.
export const BREAKDOWN_REQUIRED_DISPLAYS: ReadonlySet<DisplayType> = new Set(["pie", "bar"]);

export const WidgetSpecSchema = z
  .object({
    view: z.enum(["spans", "traces"]),
    filters: z.array(WidgetFilterSchema).default([]),
    metric: z.object({ measure: z.string().min(1), agg: z.enum(AGGS) }),
    breakdown: z.string().nullable().default(null),
    display: z.object({ type: z.enum(DISPLAY_TYPES) }),
  })
  .superRefine((spec, ctx) => {
    if (BREAKDOWN_REQUIRED_DISPLAYS.has(spec.display.type) && spec.breakdown === null) {
      ctx.addIssue({
        code: "custom",
        path: ["breakdown"],
        message: `${spec.display.type} requires a breakdown dimension`,
      });
    }
  });
export type WidgetSpec = z.infer<typeof WidgetSpecSchema>;

// Partial spec held by the builder while the user fills steps.
export type DraftSpec = Partial<Omit<WidgetSpec, "metric" | "display">> & {
  metric?: Partial<WidgetSpec["metric"]>;
  display?: Partial<WidgetSpec["display"]>;
};

export function parseSpec(draft: unknown): WidgetSpec | null {
  return WidgetSpecSchema.safeParse(draft).data ?? null;
}

export function isSpecComplete(draft: unknown): draft is WidgetSpec {
  return parseSpec(draft) !== null;
}

export interface DashboardSummary {
  id: string;
  name: string;
  description: string | null;
  isDefault: boolean;
  updateTime: string;
}

export interface LayoutItem {
  i: string; // widget id
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Widget {
  id: string;
  dashboardId: string;
  title: string;
  type: "query" | "trace_feed";
  spec: Record<string, unknown>;
  displayConfig: Record<string, unknown>;
}

export interface DashboardDetail extends DashboardSummary {
  layout: LayoutItem[];
  widgets: Widget[];
}

export interface WidgetQueryResult {
  columns: string[];
  rows: (string | number | null)[][];
  meta: { granularity?: "hour" | "day" };
}

export interface WidgetSchemaField {
  type: "string" | "number";
  label: string;
  filterOps: string[];
  groupable: boolean;
  aggs: string[];
  // Whether the query engine can histogram this measure (numeric column, not
  // the count(*) sentinel). Optional so older cached schemas keep working;
  // treat absence as histogrammable.
  histogrammable?: boolean;
}

export type WidgetSchema = Record<
  "spans" | "traces",
  { fields: Record<string, WidgetSchemaField> }
>;

export interface WidgetFieldValue {
  value: string;
  count: number;
}

export interface WidgetFieldValuesResponse {
  field: string;
  values: WidgetFieldValue[];
}

/**
 * Whether a filter's value is one of the field's stored values (so the builder
 * offers a dropdown of them). Equality on a string dimension is enumerable;
 * `contains` stays free text and numeric fields take a number input.
 */
export function isEnumerableFilter(field: WidgetSchemaField | undefined, op: string): boolean {
  return !!field && field.type === "string" && (op === "=" || op === "!=");
}

export interface FieldUnit {
  prefix?: string;
  suffix?: string;
}

// Units for fields that carry one — shared by the builder's filter inputs and
// the stat renderer. Moving these into the backend registry's schema is a
// tracked follow-up; until then this map is the frontend's single copy.
export const FIELD_UNIT: Record<string, FieldUnit> = {
  cost: { prefix: "$" },
  duration_ms: { suffix: "ms" },
};

// Numeric comparison symbols shared with the trace-list filter chips.
const NUMERIC_OP_SYMBOL: Record<string, string> = { ">=": "≥", "<=": "≤", "!=": "≠" };

/**
 * Display label for a filter operator, matching the trace-list filter builder's
 * vocabulary: string equality reads as "is" / "is not"; numeric comparisons use
 * the same symbols (≥ ≤ ≠). Presentation only — the wire op is unchanged.
 */
export function filterOpLabel(field: WidgetSchemaField | undefined, op: string): string {
  if (field?.type === "string") {
    if (op === "=") return "is";
    if (op === "!=") return "is not";
    return op;
  }
  return NUMERIC_OP_SYMBOL[op] ?? op;
}

// Display words for aggregations in generated widget titles.
const AGG_TITLE: Record<string, string> = {
  count: "Count",
  sum: "Total",
  avg: "Avg",
  min: "Min",
  max: "Max",
  p50: "p50",
  p95: "p95",
  p99: "p99",
};

/**
 * Auto-generated widget name for the builder: "{Agg} {measure label}" plus
 * " by {breakdown label}" when a breakdown is set (e.g. "p95 Latency by Model",
 * "Count of spans"). Empty until measure and agg are chosen. The builder shows
 * this until the user edits the name, then never overwrites their text.
 */
export function generateWidgetTitle(
  draft: DraftSpec,
  viewFields: Record<string, WidgetSchemaField>,
): string {
  const measure = draft.metric?.measure;
  const agg = draft.metric?.agg;
  if (!measure || !agg) return "";
  const base =
    measure === "count"
      ? `Count of ${draft.view ?? "rows"}`
      : `${AGG_TITLE[agg] ?? agg} ${viewFields[measure]?.label ?? measure}`;
  if (!draft.breakdown) return base;
  return `${base} by ${viewFields[draft.breakdown]?.label ?? draft.breakdown}`;
}

export interface TimeRange {
  start: Date;
  end: Date;
}
