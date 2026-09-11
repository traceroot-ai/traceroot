/**
 * Turns a completed write-tool step into the card the assistant panel shows in
 * place of the plain tool line — the receipt for a resource the agent created.
 *
 * Two rules shape everything here:
 * - The resource's identity comes from the step's structured `details`, read
 *   through the one validator (resourceCreatedDetails), never from the result
 *   text. Result text is prose written for the model, so it is not a source.
 * - Everything the card *shows* comes from the arguments the model supplied.
 *   Those arrive as untyped JSON — over the stream live, out of a metadata
 *   column from history — so every named read is guarded and every printed
 *   value is length-capped. An unreadable payload yields a thinner card rather
 *   than a broken one, and never the string an object stringifies to.
 *
 * A resource type with no body below has no card at all: the caller keeps the
 * plain tool step rather than rendering half of one.
 */

import {
  ALERT_THRESHOLD_OPERATOR_LABELS,
  ALERT_THRESHOLD_OPERATOR_PHRASES,
  describeAlertFilter,
  getMeasure,
  isAlertAggregation,
  isAlertSeverity,
  isAlertStatus,
  isAlertThresholdOperator,
  isAlertView,
  isAlertWindow,
  type AlertAggregation,
  type AlertFilter,
  type AlertSeverity,
  type AlertStatus,
  type AlertThresholdOperator,
  type AlertView,
  type AlertWindow,
} from "@traceroot/core";
import { formatDate, formatRelativeTime } from "@/lib/utils";
import { DETECTOR_TEMPLATES } from "@/features/detectors/templates";
import { triggerFieldDef, triggerOpLabel } from "@/features/detectors/trigger-fields";
import { resolveSiteRange } from "@/features/dashboards/range-presets";
import type { DateFilterOption } from "@/lib/date-filter";
import {
  isWidgetType,
  parseSpec,
  type WidgetSpec,
  type WidgetType,
} from "@/features/dashboards/types";
import {
  appendWidgetPlacement,
  type WidgetPlacement,
} from "@/features/dashboards/widget-placement";
import { resourceCreatedDetails, type ResourceCreatedDetails } from "./resource-created";
import type { AIMessage, ToolCallStep } from "../types";

/** The resource types that have a card body; anything else keeps the tool line. */
const RESOURCE_TYPE_LABELS = {
  widget: "Widget",
  dashboard: "Dashboard",
  project: "Project",
  workspace: "Workspace",
  detector: "Detector",
  alert: "Alert",
} as const;

export type CardResourceType = keyof typeof RESOURCE_TYPE_LABELS;

/** One line of a project/workspace receipt. */
export interface ReceiptRow {
  label: string;
  value: string;
}

/**
 * What a widget card needs to draw the widget itself: the spec the model asked
 * for, the project to run it against, and the window to run it over. Null on a
 * card that has no chart to draw — a trace feed, a spec the widget schema
 * rejects, or details that never said which project the widget landed in.
 *
 * `range` is resolved once here and carried, rather than re-resolved by the
 * plot: the card's header names the window at model-build time while the plot
 * freezes it at first visibility, and a selection changed in between would
 * leave the card labeled one window and drawn over another. One snapshot
 * feeds both.
 */
export interface WidgetChart {
  projectId: string;
  spec: WidgetSpec;
  range: DateFilterOption;
}

/**
 * One tile of the dashboard preview: what the real tile body needs to draw
 * the widget the dashboard's own way — its type and its spec exactly as the
 * call supplied it (the body parses the spec itself, so one the schema
 * rejects shows the dashboard's own invalid-spec face), the project its
 * query runs against — plus its name and its place on the real grid in grid
 * units.
 */
export interface PreviewTile {
  id: string;
  title: string;
  projectId: string;
  widget: { type: WidgetType; spec: Record<string, unknown> };
  /** The window this tile queries, snapshotted when the card model was built
   *  so the card's header and the preview cannot name different ranges. */
  range: DateFilterOption;
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * What the detector card says about the prompt the detector will run: the
 * call's own instructions verbatim, or the name of the standard template
 * whose canonical instructions apply because the call omitted a prompt.
 */
export type DetectorPrompt =
  | { kind: "custom"; text: string }
  | { kind: "standard"; templateLabel: string };

/**
 * The card body for each resource type. A dashboard's body is a scaled-down
 * preview of itself: its widgets as placed tiles (empty when the transcript
 * created none, or when the dashboard was reused and its placements are
 * unknowable — the reused card shows its description instead). A detector's
 * body is its prompt — the thing the detector actually is — over its
 * settings chips. An alert's body is the chart the alert form previews —
 * the measure over the page's window with the threshold drawn across it —
 * over chips for the rule's parts, its filters, renotify and no-data
 * handling.
 */
export type ResourceCardBody =
  | { kind: "widget"; chips: string[]; chart: WidgetChart | null }
  | { kind: "dashboard"; tiles: PreviewTile[] }
  | { kind: "receipt"; rows: ReceiptRow[] }
  | { kind: "detector"; chips: string[]; prompt: DetectorPrompt | null }
  | { kind: "alert"; chips: string[]; chart: AlertChart | null };

/**
 * A threshold rule as the alert form and the evaluator both read it. Every
 * enum is already checked, so a chart or a chip built from it never has to.
 */
export interface AlertRule {
  view: AlertView;
  measure: string;
  aggregation: AlertAggregation;
  window: AlertWindow;
  operator: AlertThresholdOperator;
  threshold: number;
  filters: AlertFilter[];
}

/**
 * What an alert card needs to draw the rule's chart: the rule, the project
 * to run it against, and the window to run it over — snapshotted once, for
 * the same reason a widget chart's is (see WidgetChart).
 */
export interface AlertChart extends AlertRule {
  projectId: string;
  range: DateFilterOption;
}

/** The fields the alerts feature's badge resolves a display state from. */
export interface AlertBadge {
  status: AlertStatus;
  severity: AlertSeverity;
  lastError: string | null;
  lastEvaluatedAt: string | null;
  lastNotifyStatus: string | null;
  lastNotifyError: string | null;
}

export interface ResourceCardModel {
  resourceType: CardResourceType;
  resourceId: string;
  /** false when the write was idempotent and an existing resource was reused. */
  created: boolean;
  title: string;
  /** Parts of the footer's meta line, joined by the renderer. */
  meta: string[];
  /** The resource's own page, or null when there is none to open: a pending
   *  card (the resource does not exist yet), a project or workspace receipt
   *  (no page of their own here), or details that left out the scope. */
  href: string | null;
  /** A description the args carried, when the type has nothing else to show
   *  (a pending dashboard — its widgets arrive as separate calls — or a
   *  reused dashboard, whose preview cannot be trusted). */
  description?: string;
  /** An alert's evaluation state, shown as the alerts page's own badge in
   *  the footer — on a receipt or a read, never on a proposal. */
  badge?: AlertBadge;
  /** Label/value rows the definition panel lists under the chips: an alert
   *  read's evaluation facts (alerting since, last evaluated, notified). */
  facts?: ReceiptRow[];
  /** True when the definition panel opens with the card: a read whose
   *  answer IS the definition should not hide it behind a click. */
  definitionOpen?: boolean;
  body: ResourceCardBody;
}

/** At most this many trigger conditions get their own chip; the rest are counted. */
const MAX_TRIGGER_CHIPS = 3;
/** At most this many alert filters get their own chip; the rest are counted. */
const MAX_FILTER_CHIPS = 3;

/**
 * Caps on what a card prints. The panel is narrow and a chip is one line, so a
 * model-supplied name long enough to dominate the transcript is cut here rather
 * than left to the layout.
 */
const MAX_TITLE_CHARS = 120;
const MAX_VALUE_CHARS = 64;
/** A detector prompt is the card's main content, so it gets real room — but a
 *  runaway payload is still cut rather than left to flood the transcript. */
const MAX_PROMPT_CHARS = 2000;

function isCardResourceType(value: string): value is CardResourceType {
  return Object.prototype.hasOwnProperty.call(RESOURCE_TYPE_LABELS, value);
}

function plainObject(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

/** A non-empty string field, trimmed and capped — or null for anything else. */
function str(value: unknown, max = MAX_VALUE_CHARS): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed === "") return null;
  return trimmed.length > max ? `${trimmed.slice(0, max)}…` : trimmed;
}

/** A value safe to print in a chip or a receipt row. */
function scalar(value: unknown): string | null {
  if (typeof value === "string") return str(value);
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

/**
 * A chart widget's spec as chips — view, metric, breakdown, display, in the
 * order the spec reads. A trace-feed widget has none of those, so it names
 * itself and its row limit instead.
 */
function widgetChips(args: Record<string, unknown>): string[] {
  const spec = plainObject(args.spec) ?? {};
  const view = str(spec.view);
  if (view === null) {
    if (str(args.type) !== "trace_feed") return [];
    const chips = ["trace feed"];
    if (typeof spec.limit === "number" && Number.isFinite(spec.limit)) {
      chips.push(`${spec.limit} rows`);
    }
    return chips;
  }

  const chips = [`view ${view}`];
  const metric = plainObject(spec.metric);
  const agg = metric === null ? null : str(metric.agg);
  const measure = metric === null ? null : str(metric.measure);
  if (agg !== null && measure !== null) chips.push(`${agg}(${measure})`);
  const breakdown = str(spec.breakdown);
  if (breakdown !== null) chips.push(`by ${breakdown}`);
  const display = plainObject(spec.display);
  const displayType = display === null ? null : str(display.type);
  if (displayType !== null) chips.push(displayType);
  return chips;
}

/**
 * The project a created widget's query is aimed at, or null when the details
 * never said. It comes from the structured details, not the arguments: it is
 * the scope the write actually landed in. Not str(): this id addresses a
 * request rather than being printed, so it is checked but never capped.
 */
function scopeProjectId(details: ResourceCreatedDetails): string | null {
  const projectId = typeof details.projectId === "string" ? details.projectId.trim() : "";
  return projectId === "" ? null : projectId;
}

/**
 * What the card needs to draw the widget the model just created, or null when
 * it can't be drawn. The spec goes through the dashboard's own schema, so the
 * preview runs exactly the spec a dashboard tile would — a trace feed's spec
 * (rows and filters, no view or metric) fails that parse, which is why a feed
 * card keeps its chips and never queries.
 */
function widgetChart(
  args: Record<string, unknown>,
  details: ResourceCreatedDetails,
  retentionDays?: number | null,
): WidgetChart | null {
  const projectId = scopeProjectId(details);
  if (projectId === null) return null;
  const spec = parseSpec(args.spec);
  return spec === null
    ? null
    : { projectId, spec, range: resolveSiteRange(projectId, retentionDays) };
}

/**
 * One trigger condition in the detector editor's own vocabulary ("Latency ≥
 * 30000"), or null when the condition is not the shape the editor writes.
 */
function triggerChip(condition: unknown): string | null {
  const parsed = plainObject(condition);
  if (parsed === null) return null;
  const field = str(parsed.field);
  const op = str(parsed.op);
  const value = scalar(parsed.value);
  if (field === null || op === null || value === null) return null;
  const def = triggerFieldDef(field);
  return `${def?.label ?? field} ${triggerOpLabel(def, op)} ${value}`;
}

/**
 * A detector's settings as chips: how much traffic it samples, whether RCA
 * runs, the model that judges, then the trigger conditions in the detector
 * editor's own vocabulary. The enabled flag is not a chip — a new detector
 * is enabled by default and the UI never sets it at create time — and the
 * prompt is not one either: it is the card's body (see detectorPrompt).
 */
function detectorChips(args: Record<string, unknown>): string[] {
  const chips: string[] = [];
  if (typeof args.sample_rate === "number" && Number.isFinite(args.sample_rate)) {
    chips.push(`sample ${args.sample_rate}%`);
  }
  if (typeof args.enable_rca === "boolean") chips.push(args.enable_rca ? "RCA on" : "RCA off");
  const detectionModel = str(args.detection_model);
  if (detectionModel !== null) chips.push(`model ${detectionModel}`);

  if (Array.isArray(args.trigger_conditions)) {
    const triggers = args.trigger_conditions
      .map(triggerChip)
      .filter((chip): chip is string => chip !== null);
    chips.push(...triggers.slice(0, MAX_TRIGGER_CHIPS));
    const hidden = triggers.length - MAX_TRIGGER_CHIPS;
    if (hidden > 0) chips.push(`+${hidden} more`);
  }
  return chips;
}

/**
 * The unit a measure's threshold is stated in, where the bare number would
 * mislead. Keyed by alert measure id; mirrors FIELD_UNIT in the filter
 * controls, which keys the same two units by engine field.
 */
const MEASURE_UNITS: Record<string, { prefix?: string; suffix?: string }> = {
  latency: { suffix: " ms" },
  cost: { prefix: "$" },
};

/** "2000" as "2,000 ms", "5" as "$5": the threshold in the measure's unit. */
function thresholdWords(measure: string, threshold: number): string {
  const unit = MEASURE_UNITS[measure] ?? {};
  return `${unit.prefix ?? ""}${threshold.toLocaleString("en-US")}${unit.suffix ?? ""}`;
}

/**
 * The filters an alert record carries that are really filters: a field, an
 * operator and a printable value (plus a key when there is one). Anything
 * else is left out rather than printed as the text an object stringifies to.
 */
function alertFilters(record: Record<string, unknown>): AlertFilter[] {
  if (!Array.isArray(record.filters)) return [];
  const filters: AlertFilter[] = [];
  for (const entry of record.filters) {
    const parsed = plainObject(entry);
    if (parsed === null) continue;
    const field = str(parsed.field);
    const op = str(parsed.op);
    const value =
      typeof parsed.value === "number" && Number.isFinite(parsed.value)
        ? parsed.value
        : str(parsed.value);
    if (field === null || op === null || value === null) continue;
    const key = str(parsed.key);
    filters.push(key === null ? { field, op, value } : { field, key, op, value });
  }
  return filters;
}

/**
 * The rule a snake_case alert record describes — a create_alert call's
 * arguments and the alert reads' payloads share the shape — or null when a
 * part the chart cannot do without is missing or outside the vocabulary. A
 * chip can still show a piece the rule as a whole cannot use.
 */
function alertRuleOf(record: Record<string, unknown>): AlertRule | null {
  const view = str(record.view);
  const measure = str(record.measure);
  const aggregation = str(record.aggregation);
  const window = str(record.window);
  const operator = str(record.threshold_operator);
  const threshold = record.threshold;
  if (
    view === null ||
    !isAlertView(view) ||
    measure === null ||
    aggregation === null ||
    !isAlertAggregation(aggregation) ||
    window === null ||
    !isAlertWindow(window) ||
    operator === null ||
    !isAlertThresholdOperator(operator) ||
    typeof threshold !== "number" ||
    !Number.isFinite(threshold)
  ) {
    return null;
  }
  return {
    view,
    measure,
    aggregation,
    window,
    operator,
    threshold,
    filters: alertFilters(record),
  };
}

/**
 * An alert's definition as chips, in the order the rule reads: the view, the
 * aggregated measure, the window, the comparison with its unit, then each
 * filter in the alerts feature's own wording (capped, the rest counted),
 * whether a sustained breach keeps paging, and what a window with nothing
 * in it means when the record says. Each chip stands on its own, so a rule
 * the write would refuse still shows the parts it was given.
 */
function alertChips(record: Record<string, unknown>): string[] {
  const chips: string[] = [];
  const view = str(record.view);
  if (view !== null) chips.push(`view ${view.toLowerCase()}`);
  const aggregation = str(record.aggregation);
  const measure = str(record.measure);
  if (aggregation !== null && measure !== null) chips.push(`${aggregation}(${measure})`);
  const window = str(record.window);
  if (window !== null) chips.push(`over ${window}`);
  const operator = str(record.threshold_operator);
  const threshold = record.threshold;
  if (operator !== null && typeof threshold === "number" && Number.isFinite(threshold)) {
    const label = isAlertThresholdOperator(operator)
      ? ALERT_THRESHOLD_OPERATOR_LABELS[operator]
      : operator;
    chips.push(`${label} ${thresholdWords(measure ?? "", threshold)}`);
  }

  const filters = alertFilters(record).map(describeAlertFilter);
  chips.push(...filters.slice(0, MAX_FILTER_CHIPS));
  const hidden = filters.length - MAX_FILTER_CHIPS;
  if (hidden > 0) chips.push(`+${hidden} more`);

  const renotify = plainObject(record.renotify);
  const mode = renotify === null ? null : str(renotify.mode);
  if (mode === "EVERY") {
    const minutes = renotify === null ? null : scalar(renotify.interval_minutes);
    chips.push(minutes === null ? "renotify" : `renotify every ${minutes} min`);
  } else if (mode === "OFF") {
    chips.push("renotify off");
  }

  const noData = str(record.no_data_mode);
  if (noData !== null) chips.push(`no data → ${noData}`);
  return chips;
}

/**
 * The rule in one line for a list row — "p95 latency > 2,000 ms over 10m" —
 * or null when the record does not carry a whole rule. The measure reads by
 * its catalog label; a count rule is just "count".
 */
function alertRuleSummary(record: Record<string, unknown>): string | null {
  const rule = alertRuleOf(record);
  if (rule === null) return null;
  const label = getMeasure(rule.view, rule.measure)?.label.toLowerCase() ?? rule.measure;
  const subject = rule.aggregation === "count" ? "count" : `${rule.aggregation} ${label}`;
  return `${subject} ${ALERT_THRESHOLD_OPERATOR_LABELS[rule.operator]} ${thresholdWords(rule.measure, rule.threshold)} over ${rule.window}`;
}

/** How an aggregation reads before its measure in a sentence: "total cost", "p95 latency". */
const AGGREGATION_WORDS: Record<string, string> = {
  sum: "total",
  avg: "average",
  min: "minimum",
  max: "maximum",
  uniq: "distinct",
};

/** "10m" as words: "10 minutes"; "1h" as "1 hour". */
function windowWords(window: string): string {
  const parsed = /^(\d+)([mh])$/.exec(window);
  if (parsed === null) return window;
  const count = Number(parsed[1]);
  const unit = parsed[2] === "m" ? "minute" : "hour";
  return `${count} ${unit}${count === 1 ? "" : "s"}`;
}

/**
 * The whole rule in one sentence for the definition panel — "p95 latency
 * over 10 minutes is above 2,000 ms" — or null when the record does not
 * carry a whole rule. The chips spell the parts; this is the reading.
 */
function alertRuleSentence(record: Record<string, unknown>): string | null {
  const rule = alertRuleOf(record);
  if (rule === null) return null;
  const label = getMeasure(rule.view, rule.measure)?.label.toLowerCase() ?? rule.measure;
  const subject =
    rule.aggregation === "count"
      ? "span count"
      : `${AGGREGATION_WORDS[rule.aggregation] ?? rule.aggregation} ${label}`;
  return `${subject} over ${windowWords(rule.window)} is ${ALERT_THRESHOLD_OPERATOR_PHRASES[rule.operator]} ${thresholdWords(rule.measure, rule.threshold)}`;
}

/**
 * The badge input off a snake_case alert record, or null when its status or
 * severity is not one the alerts feature knows — a badge must not guess.
 */
function alertBadgeOf(record: Record<string, unknown>): AlertBadge | null {
  const status = str(record.status);
  const severity = str(record.severity);
  if (
    status === null ||
    !isAlertStatus(status) ||
    severity === null ||
    !isAlertSeverity(severity)
  ) {
    return null;
  }
  return {
    status,
    severity,
    lastError: str(record.last_error, MAX_PROMPT_CHARS),
    lastEvaluatedAt: str(record.last_evaluated_at),
    lastNotifyStatus: str(record.last_notify_status),
    lastNotifyError: str(record.last_notify_error),
  };
}

/**
 * The same, off the camelCase state a create receipt's details carry (the
 * write route's own row shape).
 */
function alertBadgeOfState(state: unknown): AlertBadge | null {
  const record = plainObject(state);
  if (record === null) return null;
  return alertBadgeOf({
    status: record.status,
    severity: record.severity,
    last_error: record.lastError,
    last_evaluated_at: record.lastEvaluatedAt,
    last_notify_status: record.lastNotifyStatus,
    last_notify_error: record.lastNotifyError,
  });
}

/** The chart for a rule aimed at a project, over the site's stored window. */
function alertChart(
  record: Record<string, unknown>,
  projectId: string | null,
  retentionDays?: number | null,
): AlertChart | null {
  const rule = alertRuleOf(record);
  if (rule === null || projectId === null) return null;
  return { ...rule, projectId, range: resolveSiteRange(projectId, retentionDays) };
}

/** An alert body: its chart and its chips, both read from one record. */
function alertBody(
  record: Record<string, unknown> | null,
  projectId: string | null,
  retentionDays?: number | null,
): ResourceCardBody {
  if (record === null) return { kind: "alert", chips: [], chart: null };
  return {
    kind: "alert",
    chips: alertChips(record),
    chart: alertChart(record, projectId, retentionDays),
  };
}

/**
 * A project or workspace has nothing to picture, so the card is a receipt of
 * where the one call put it: the workspace it landed in (a workspace itself
 * lands in nothing, so it has only an id) and the id it was given. Both come
 * from the details alone — nothing else about a project is knowable without
 * going back to the server, and a receipt must not go fetching.
 */
function receiptRows(details: ResourceCreatedDetails): ReceiptRow[] {
  const rows: ReceiptRow[] = [];
  const workspaceId = str(details.workspaceId);
  if (workspaceId !== null) rows.push({ label: "workspace", value: workspaceId });
  const resourceId = str(details.resourceId);
  if (resourceId !== null) rows.push({ label: "id", value: resourceId });
  return rows;
}

/**
 * A dashboard's widgets as preview tiles, placed by folding each creation
 * (in transcript order) through the same placement function the widget create
 * route uses — so the preview and the real grid cannot disagree. An
 * unreadable type falls back to a chart tile, the smaller of the two sizes;
 * a replayed create (same widget id twice) keeps its first tile. A widget
 * whose details name no project gets no tile — nothing could be queried for
 * it — but still takes its place in the fold, because the real grid placed
 * it and the tiles after it must land where they really did.
 */
function dashboardTiles(
  steps: readonly ToolCallStep[],
  retentionDays?: number | null,
): PreviewTile[] {
  let layout: WidgetPlacement[] = [];
  const tiles: PreviewTile[] = [];
  for (const step of steps) {
    const details = resourceCreatedDetails(step.result);
    if (details === null) continue;
    const args = plainObject(step.args);
    const rawType = args?.type;
    const type: WidgetType = isWidgetType(rawType) ? rawType : "query";
    const next = appendWidgetPlacement(layout, { id: details.resourceId, type });
    if (next === null) continue;
    layout = next;
    const projectId = scopeProjectId(details);
    if (projectId === null) continue;
    const { x, y, w, h } = layout[layout.length - 1];
    tiles.push({
      id: details.resourceId,
      title: (args === null ? null : str(args.title)) ?? str(details.resourceId) ?? "",
      projectId,
      // The spec as supplied, unparsed: the tile body applies the dashboard's
      // own schema and shows the dashboard's own face for a spec it rejects.
      widget: { type, spec: plainObject(args?.spec) ?? {} },
      // Resolved once here, not again by the preview: the card's header names
      // this window at model-build time while the preview freezes it at first
      // visibility, and a selection changed in between would leave the two
      // naming different ranges.
      range: resolveSiteRange(projectId, retentionDays),
      x,
      y,
      w,
      h,
    });
  }
  return tiles;
}

/**
 * "failure" -> "Failure" when it names a standard template; "blank" -> the
 * word a reader understands — a blank-template detector is a custom one, and
 * the internal id would read as a detector with nothing in it. The raw id
 * stands for anything unrecognised.
 */
function templateLabel(template: string): string {
  if (template === "blank") return "Custom";
  return DETECTOR_TEMPLATES.find((t) => t.id === template)?.label ?? template;
}

/**
 * The prompt the detector will actually run, as the card presents it. A
 * supplied prompt is shown verbatim (capped) — it overrides any template
 * default. An omitted prompt on a standard template means the template's
 * canonical instructions, so the card names them rather than staying mute.
 * A blank template with no prompt has nothing to claim.
 *
 * Seam: when a supplied prompt is a modified copy of its standard template's
 * default, a diff-vs-template treatment could show just what changed; for now
 * a custom prompt always renders whole.
 */
function detectorPrompt(args: Record<string, unknown>): DetectorPrompt | null {
  const prompt = str(args.prompt, MAX_PROMPT_CHARS);
  if (prompt !== null) return { kind: "custom", text: prompt };
  const template = str(args.template);
  // The blank template's default prompt is empty, so requiring a non-empty
  // template prompt excludes it without naming it.
  const standard =
    template === null
      ? undefined
      : DETECTOR_TEMPLATES.find((t) => t.id === template && t.prompt !== "");
  return standard === undefined ? null : { kind: "standard", templateLabel: standard.label };
}

/**
 * An id safe to splice into a route: the server mints plain ids, so anything
 * with a separator or a dot-segment in it is not an id and gets no link,
 * rather than a link that escapes the page it names.
 */
function pathSegment(value: unknown): string | null {
  return typeof value === "string" && /^[A-Za-z0-9_-]+$/.test(value) ? value : null;
}

/**
 * The page the created resource lives on. A widget has no page of its own —
 * its dashboard is where it shows — and a detector opens its detail page. A
 * project or workspace receipt opens nothing: the panel is scoped to one
 * project, and the receipt is the whole story of the write.
 */
function resourceHref(resourceType: CardResourceType, details: ResourceCreatedDetails) {
  const projectId = pathSegment(details.projectId);
  if (projectId === null) return null;
  switch (resourceType) {
    case "widget": {
      const dashboardId = pathSegment(details.dashboardId);
      return dashboardId === null ? null : `/projects/${projectId}/dashboard/${dashboardId}`;
    }
    case "dashboard": {
      const dashboardId = pathSegment(details.resourceId);
      return dashboardId === null ? null : `/projects/${projectId}/dashboard/${dashboardId}`;
    }
    case "detector": {
      const detectorId = pathSegment(details.resourceId);
      return detectorId === null ? null : `/projects/${projectId}/detectors/${detectorId}`;
    }
    case "alert": {
      const alertId = pathSegment(details.resourceId);
      return alertId === null ? null : `/projects/${projectId}/alerts/${alertId}`;
    }
    default:
      return null;
  }
}

function body(
  resourceType: CardResourceType,
  args: Record<string, unknown> | null,
  details: ResourceCreatedDetails,
  widgetSteps: readonly ToolCallStep[],
  retentionDays?: number | null,
): ResourceCardBody {
  switch (resourceType) {
    case "widget":
      if (args === null) return { kind: "widget", chips: [], chart: null };
      return {
        kind: "widget",
        chips: widgetChips(args),
        chart: widgetChart(args, details, retentionDays),
      };
    case "dashboard":
      // Only a freshly CREATED dashboard gets a preview. A reused
      // (idempotent-hit) dashboard was laid out before this transcript
      // existed, so folding its new widgets through an empty layout would
      // draw tile positions the real grid never assigned — the card keeps
      // the count/description body instead.
      return {
        kind: "dashboard",
        tiles: details.created !== false ? dashboardTiles(widgetSteps, retentionDays) : [],
      };
    case "detector":
      return {
        kind: "detector",
        chips: args === null ? [] : detectorChips(args),
        prompt: args === null ? null : detectorPrompt(args),
      };
    case "alert":
      // The chart is aimed where the write landed, like a widget's.
      return alertBody(args, scopeProjectId(details), retentionDays);
    default:
      return { kind: "receipt", rows: receiptRows(details) };
  }
}

/**
 * The card for one completed tool step, or null when the step is not a
 * recognised resource creation — an ordinary tool call, a soft failure that
 * returned no details, or a resource type this panel has no body for. The
 * caller renders the plain tool step for every null.
 *
 * `widgetsByDashboard` supplies the widgets created into each dashboard, for
 * the card's count and its preview; see createdWidgetsByDashboard.
 *
 * `retentionDays` is the plan's window; it clamps the range every chart here
 * queries and every window label. Undefined while the plan is still
 * resolving, which clamps nothing.
 */
export function resourceCardModel(
  step: ToolCallStep,
  widgetsByDashboard?: ReadonlyMap<string, readonly ToolCallStep[]>,
  retentionDays?: number | null,
): ResourceCardModel | null {
  const details = resourceCreatedDetails(step.result);
  if (details === null || !isCardResourceType(details.resourceType)) return null;
  const resourceType = details.resourceType;

  const args = plainObject(step.args);
  // The details say what the resource is really called — for a dashboard,
  // possibly a suffixed name the args never asked for. Older rows carry no
  // name, so the args stand in: widgets carry a title, everything else a
  // name. Neither survives an unreadable payload, so the id — always
  // present — stands in last.
  const displayName =
    str(details.name, MAX_TITLE_CHARS) ??
    (args === null ? null : (str(args.title, MAX_TITLE_CHARS) ?? str(args.name, MAX_TITLE_CHARS)));

  const cardBody = body(
    resourceType,
    args,
    details,
    widgetsByDashboard?.get(details.resourceId) ?? [],
    retentionDays,
  );

  const meta: string[] = [RESOURCE_TYPE_LABELS[resourceType]];
  // A chart is a number without context until the window it covers is named —
  // and the name must be the range the chart actually queries: the site's
  // stored selection for the chart's own project, default otherwise.
  if (cardBody.kind === "widget" && cardBody.chart !== null) {
    meta.push(cardBody.chart.range.label);
  }
  if (resourceType === "dashboard") {
    const widgetCount = widgetsByDashboard?.get(details.resourceId)?.length ?? 0;
    if (widgetCount > 0) meta.push(widgetCount === 1 ? "1 widget" : `${widgetCount} widgets`);
    // One window label for the whole preview — every tile, feed included,
    // queries the one frozen range, so naming it per tile would be twelve
    // copies of one fact. The first tile carries the snapshot, the same one
    // the preview draws over.
    const [firstTile] = cardBody.kind === "dashboard" ? cardBody.tiles : [];
    if (firstTile !== undefined) meta.push(firstTile.range.label);
  }
  if (resourceType === "detector" && args !== null) {
    const template = str(args.template);
    if (template !== null) meta.push(templateLabel(template));
  }
  if (cardBody.kind === "alert" && cardBody.chart !== null) {
    meta.push(cardBody.chart.range.label);
  }
  // The receipt shows the state the alert was created in — the alerts
  // page's own badge, reading a rule that has not run yet as exactly that.
  const badge = resourceType === "alert" ? alertBadgeOfState(details.alertState) : null;

  // A reused dashboard draws no preview (see body above), so its card gets
  // what the pending card shows: the description the call carried, if any.
  // A renamed one was created, so it keeps its preview; the definition panel
  // instead explains why its title is not the name the call asked for. An
  // alert's definition opens with its rule read as one sentence.
  const renamedFrom = str(details.renamedFrom, MAX_TITLE_CHARS);
  const description =
    renamedFrom !== null
      ? `Renamed from "${renamedFrom}": a ${resourceType} with that name already existed.`
      : resourceType === "dashboard" && details.created === false && args !== null
        ? str(args.description, MAX_DESCRIPTION_CHARS)
        : resourceType === "alert" && args !== null
          ? alertRuleSentence(args)
          : null;

  return {
    resourceType,
    resourceId: details.resourceId,
    created: details.created !== false,
    title: displayName ?? str(details.resourceId, MAX_TITLE_CHARS) ?? "",
    meta,
    href: resourceHref(resourceType, details),
    ...(description === null ? {} : { description }),
    ...(badge === null ? {} : { badge }),
    body: cardBody,
  };
}

/** The resource types a proposal can park as a card in the chat. */
export type PendingResourceType = Extract<
  CardResourceType,
  "widget" | "dashboard" | "detector" | "alert"
>;

/**
 * The confirm-class write tools and the resource each would create. Structural
 * creates (project, workspace) are CLI/API surface and never park in chat, so
 * they have no pending card — only the receipt card, once created elsewhere.
 */
const PENDING_TOOL_RESOURCE_TYPES: Readonly<Record<string, PendingResourceType>> = {
  create_widget: "widget",
  create_dashboard: "dashboard",
  create_detector: "detector",
  create_alert: "alert",
};

/** A pending dashboard's description is prose, so it gets more room than a chip. */
const MAX_DESCRIPTION_CHARS = 200;

/**
 * What a parked write proposes, in the words the approval bar asks with: the
 * resource it would create and the name the call gave it (null when the args
 * carry none). Null for a tool this panel has no proposal card
 * for — the composer then offers no buttons, and only a typed reply can
 * answer the call.
 */
export function pendingProposal(
  step: ToolCallStep,
): { resourceType: PendingResourceType; title: string | null } | null {
  const resourceType = PENDING_TOOL_RESOURCE_TYPES[step.toolName];
  if (resourceType === undefined) return null;
  const args = plainObject(step.args);
  // Null when the args name nothing: the card falls back to the type's label,
  // while the composer's question simply asks by type.
  const title =
    args === null ? null : (str(args.title, MAX_TITLE_CHARS) ?? str(args.name, MAX_TITLE_CHARS));
  return { resourceType, title };
}

/**
 * The card for a write the agent has PROPOSED but not run — the same card the
 * receipt shows, built from the arguments alone, because the resource does not
 * exist yet and there are no `details` to read. Everything shown is what the
 * args carry; nothing is invented:
 * - a widget draws its real chart (the query endpoint is stateless, so the
 *   spec needn't exist), aimed at the panel's own project — the scope the
 *   write would land in;
 * - a dashboard can only show its name and description — its widgets arrive
 *   as separate pending calls;
 * - a detector shows the same body its receipt will;
 * - an alert shows its rule in words, the thing the user is judging.
 * Null for a tool this panel has no card for; the caller keeps the plain tool
 * line, matching the receipt convention.
 */
export function pendingCardModel(
  step: ToolCallStep,
  panelProjectId: string | undefined,
  retentionDays?: number | null,
): ResourceCardModel | null {
  const proposal = pendingProposal(step);
  if (proposal === null) return null;
  const { resourceType } = proposal;
  const title = proposal.title ?? RESOURCE_TYPE_LABELS[resourceType];
  const args = plainObject(step.args);

  let body: ResourceCardBody;
  switch (resourceType) {
    case "widget": {
      // Only a chart widget has a chart to preview: a feed's spec can parse as
      // a chart's, and previewing it would show a chart the write rejects.
      const spec = args === null || str(args.type) !== "query" ? null : parseSpec(args.spec);
      body = {
        kind: "widget",
        chips: args === null ? [] : widgetChips(args),
        chart:
          spec === null || panelProjectId === undefined
            ? null
            : {
                projectId: panelProjectId,
                spec,
                range: resolveSiteRange(panelProjectId, retentionDays),
              },
      };
      break;
    }
    case "dashboard":
      body = { kind: "dashboard", tiles: [] };
      break;
    case "detector":
      // The same body the receipt builds — the gate must show exactly what
      // the write would create, prompt included.
      body = {
        kind: "detector",
        chips: args === null ? [] : detectorChips(args),
        prompt: args === null ? null : detectorPrompt(args),
      };
      break;
    case "alert":
      // The gate must show the rule the write would store, since the rule is
      // the whole resource: its chart aimed at the panel's project — the
      // scope the write would land in — over the chips that spell it out.
      body = alertBody(args, panelProjectId ?? null, retentionDays);
      break;
  }

  const meta: string[] = [RESOURCE_TYPE_LABELS[resourceType]];
  // The pending chart is aimed at the panel's project, so its window label
  // resolves against the same project — what the preview will really query.
  if (body.kind === "widget" && body.chart !== null) {
    meta.push(body.chart.range.label);
  }
  if (resourceType === "detector" && args !== null) {
    const template = str(args.template);
    if (template !== null) meta.push(templateLabel(template));
  }
  if (body.kind === "alert" && body.chart !== null) {
    meta.push(body.chart.range.label);
  }

  const description =
    resourceType === "dashboard" && args !== null
      ? str(args.description, MAX_DESCRIPTION_CHARS)
      : resourceType === "alert" && args !== null
        ? alertRuleSentence(args)
        : null;

  return {
    resourceType,
    // The call's own id: unique and stable, it keys the chart preview's query
    // until the real widget id exists.
    resourceId: step.toolCallId,
    created: true,
    title,
    meta,
    // Nothing to open: the resource does not exist until the user says so.
    href: null,
    ...(description === null ? {} : { description }),
    body,
  };
}

/**
 * The ids of tool-step messages whose widget card would duplicate a CREATED
 * dashboard's card shown earlier in the same transcript: that dashboard's
 * preview already draws every widget the transcript created into it, so
 * those steps keep the plain tool line instead of a second card. A widget
 * whose dashboard has no card here — created into a pre-existing dashboard —
 * keeps its full card, because that card is the only receipt there is.
 *
 * A widget is suppressed only under a CREATED dashboard's card — the one that
 * draws a preview; a reused dashboard's card draws none, so its widgets
 * keep their cards — and only when that dashboard step PRECEDES the widget's
 * (the agent creates the dashboard before filling it, so anything else is a
 * widget whose dashboard card the reader has not seen).
 */
export function suppressedWidgetStepIds(messages: readonly AIMessage[]): Set<string> {
  const dashboardCards = new Set<string>();
  const suppressed = new Set<string>();
  for (const message of messages) {
    const step = message.toolStep;
    if (message.role !== "tool_step" || step === undefined) continue;
    const details = resourceCreatedDetails(step.result);
    if (details === null) continue;
    if (details.resourceType === "dashboard") {
      // Only a CREATED dashboard's card draws a preview; a reused one has
      // no picture of its widgets, so their own cards must stay — they are
      // the only true receipt in the transcript.
      if (details.created !== false) dashboardCards.add(details.resourceId);
    } else if (
      details.resourceType === "widget" &&
      typeof details.dashboardId === "string" &&
      dashboardCards.has(details.dashboardId)
    ) {
      suppressed.add(message.id);
    }
  }
  return suppressed;
}

/**
 * The widget steps of a transcript, grouped by the dashboard each was added to.
 *
 * The dashboard's own call never says how many widgets it will hold — the
 * widgets are separate calls that land after it — so the transcript is the only
 * place that count exists without going back to the server for it.
 */
export function createdWidgetsByDashboard(
  messages: readonly AIMessage[],
): Map<string, ToolCallStep[]> {
  const byDashboard = new Map<string, ToolCallStep[]>();
  const seen = new Set<string>();
  for (const message of messages) {
    const step = message.toolStep;
    if (message.role !== "tool_step" || step === undefined) continue;
    const details = resourceCreatedDetails(step.result);
    if (details === null || details.resourceType !== "widget") continue;
    if (typeof details.dashboardId !== "string") continue;
    // A replayed create (same widget id twice) keeps its first step, the same
    // convention the preview applies — otherwise the dashboard meta would
    // count one widget twice while the preview draws a single tile.
    if (seen.has(details.resourceId)) continue;
    seen.add(details.resourceId);
    const siblings = byDashboard.get(details.dashboardId);
    if (siblings === undefined) byDashboard.set(details.dashboardId, [step]);
    else siblings.push(step);
  }
  return byDashboard;
}

// ── read results ─────────────────────────────────────────────────────────────

/** One row of the list_alerts card. */
export interface AlertListRow {
  id: string;
  name: string;
  /** The rule in one line, or null when the row does not carry a whole rule. */
  summary: string | null;
  /** "evaluated 2 minutes ago", "alerted 13 minutes ago · notified", "paused". */
  state: string;
  badge: AlertBadge | null;
  /** The alert's page, or null when the panel has no project to path it under. */
  href: string | null;
}

export interface AlertListCardModel {
  rows: AlertListRow[];
  /** Alerts in the project; larger than the rows when the read was capped or paged. */
  total: number;
  capacity: { used: number; max: number } | null;
  /** The project's alerts page, or null when the panel has no project. */
  href: string | null;
}

/** The card a read-tool step renders, when the panel has one for it. */
export type ReadCardModel =
  | { kind: "alert_list"; model: AlertListCardModel }
  | { kind: "alert"; model: ResourceCardModel };

/**
 * A row's evaluation state in words: parked, then paused, outrank everything
 * (no tick will run the rule as it stands — the alerts page's own ordering),
 * then a live breach with whether it was notified, then when the rule last
 * ran, and a rule that has not run yet says so.
 */
function alertRowState(record: Record<string, unknown>): string {
  const status = str(record.status);
  if (status === "PARKED") return "parked · evaluation stopped";
  if (status === "PAUSED") return "paused";
  const alertedAt = str(record.alerted_at);
  if (alertedAt !== null) {
    const notify = str(record.last_notify_status);
    const notified =
      notify === null
        ? ""
        : notify === "DELIVERED"
          ? " · notified"
          : ` · notify ${notify.toLowerCase()}`;
    return `alerted ${formatRelativeTime(alertedAt)}${notified}`;
  }
  const evaluatedAt = str(record.last_evaluated_at);
  return evaluatedAt === null
    ? "not evaluated yet"
    : `evaluated ${formatRelativeTime(evaluatedAt)}`;
}

/** The alert's page under the panel's project, when both ids are path-safe. */
function alertPageHref(panelProjectId: string | undefined, alertId: unknown): string | null {
  const projectId = pathSegment(panelProjectId);
  const id = pathSegment(alertId);
  return projectId === null || id === null ? null : `/projects/${projectId}/alerts/${id}`;
}

function alertListCardModel(
  details: Record<string, unknown>,
  panelProjectId: string | undefined,
): AlertListCardModel | null {
  if (!Array.isArray(details.alerts)) return null;
  const rows: AlertListRow[] = [];
  for (const entry of details.alerts) {
    const record = plainObject(entry);
    if (record === null) continue;
    const id = str(record.id, MAX_TITLE_CHARS);
    if (id === null) continue;
    rows.push({
      id,
      name: str(record.name, MAX_TITLE_CHARS) ?? id,
      summary: alertRuleSummary(record),
      state: alertRowState(record),
      badge: alertBadgeOf(record),
      href: alertPageHref(panelProjectId, record.id),
    });
  }
  const capacity = plainObject(details.capacity);
  const used = capacity === null ? null : capacity.used;
  const max = capacity === null ? null : capacity.max;
  const projectId = pathSegment(panelProjectId);
  return {
    rows,
    total:
      typeof details.total === "number" && Number.isFinite(details.total)
        ? details.total
        : rows.length,
    capacity:
      typeof used === "number" &&
      typeof max === "number" &&
      Number.isFinite(used) &&
      Number.isFinite(max)
        ? { used, max }
        : null,
    href: projectId === null ? null : `/projects/${projectId}/alerts`,
  };
}

/**
 * The facts the detail card lists under the chips: when the breach began,
 * when the rule last ran, whether and when the page went out, and who wrote
 * the rule. Only what the record says — a fact it does not carry is left
 * out, not printed as unknown.
 */
function alertFacts(record: Record<string, unknown>): ReceiptRow[] {
  const rows: ReceiptRow[] = [];
  const alertedAt = str(record.alerted_at);
  if (alertedAt !== null) rows.push({ label: "alerting since", value: formatDate(alertedAt) });
  const evaluatedAt = str(record.last_evaluated_at);
  rows.push({
    label: "last evaluated",
    value: evaluatedAt === null ? "never" : formatDate(evaluatedAt),
  });
  const notify = str(record.last_notify_status);
  if (notify !== null) {
    const at = str(record.last_notify_at);
    rows.push({
      label: "notified",
      value: at === null ? notify.toLowerCase() : `${notify.toLowerCase()} · ${formatDate(at)}`,
    });
  }
  const creator = str(record.creator);
  if (creator !== null) {
    const createdAt = str(record.create_time);
    rows.push({
      label: "created by",
      value: createdAt === null ? creator : `${creator} · ${formatDate(createdAt).slice(0, 10)}`,
    });
  }
  return rows;
}

function alertDetailCardModel(
  details: Record<string, unknown>,
  panelProjectId: string | undefined,
  retentionDays?: number | null,
): ResourceCardModel | null {
  const record = plainObject(details.alert);
  if (record === null) return null;
  const id = str(record.id, MAX_TITLE_CHARS);
  if (id === null) return null;
  const body = alertBody(record, panelProjectId ?? null, retentionDays);
  const meta: string[] = [RESOURCE_TYPE_LABELS.alert];
  if (body.kind === "alert" && body.chart !== null) meta.push(body.chart.range.label);
  const badge = alertBadgeOf(record);
  const description = alertRuleSentence(record);
  return {
    resourceType: "alert",
    resourceId: id,
    created: true,
    title: str(record.name, MAX_TITLE_CHARS) ?? id,
    meta,
    href: alertPageHref(panelProjectId, record.id),
    ...(description === null ? {} : { description }),
    ...(badge === null ? {} : { badge }),
    facts: alertFacts(record),
    // The read's answer is the definition; it opens with the card.
    definitionOpen: true,
    body,
  };
}

/**
 * The card for a completed READ step whose result carries card details —
 * list_alerts and get_alert attach a compact projection of their payload
 * beside the text the model reads — or null for every other step, an
 * errored one included: the caller keeps the plain tool line, matching the
 * receipt convention. The panel's project paths the links, since a
 * project-scoped read's payload never names its project.
 */
export function readCardModel(
  step: ToolCallStep,
  panelProjectId: string | undefined,
  retentionDays?: number | null,
): ReadCardModel | null {
  if (step.status !== "done" || step.isError === true) return null;
  const result = plainObject(step.result);
  const details = result === null ? null : plainObject(result.details);
  if (details === null) return null;
  if (details.kind === "alert_list") {
    const model = alertListCardModel(details, panelProjectId);
    return model === null ? null : { kind: "alert_list", model };
  }
  if (details.kind === "alert_detail") {
    const model = alertDetailCardModel(details, panelProjectId, retentionDays);
    return model === null ? null : { kind: "alert", model };
  }
  return null;
}
