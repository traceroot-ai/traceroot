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

import { DETECTOR_TEMPLATES } from "@/features/detectors/templates";
import { triggerFieldDef, triggerOpLabel } from "@/features/detectors/trigger-fields";
import { DEFAULT_RANGE_LABEL } from "@/features/dashboards/range-presets";
import {
  DISPLAY_TYPES,
  isWidgetType,
  parseSpec,
  type DisplayType,
  type WidgetSpec,
  type WidgetType,
} from "@/features/dashboards/types";
import {
  appendWidgetPlacement,
  type WidgetPlacement,
} from "@/features/dashboards/widget-placement";
import { resourceCreatedDetails, type ResourceCreatedDetails } from "./resource-navigation";
import type { AIMessage, ToolCallStep } from "../types";

/** The resource types that have a card body; anything else keeps the tool line. */
const RESOURCE_TYPE_LABELS = {
  widget: "Widget",
  dashboard: "Dashboard",
  project: "Project",
  workspace: "Workspace",
  detector: "Detector",
} as const;

export type CardResourceType = keyof typeof RESOURCE_TYPE_LABELS;

/** One line of a project/workspace receipt. */
export interface ReceiptRow {
  label: string;
  value: string;
}

/**
 * What a widget card needs to draw the widget itself: the spec the model asked
 * for and the project to run it against. Null on a card that has no chart to
 * draw — a trace feed, a spec the widget schema rejects, or details that never
 * said which project the widget landed in.
 */
export interface WidgetChart {
  projectId: string;
  spec: WidgetSpec;
}

/**
 * What one tile of the dashboard miniature shows: the widget's name, a static
 * glyph for its shape, and its place on the real grid in grid units. Shapes,
 * not data — a dashboard card must never fan out into one query per tile, so
 * the glyph stands in for the chart the widget will draw.
 */
export type MiniatureGlyph = DisplayType | "trace_feed" | "unknown";

export interface MiniatureTile {
  id: string;
  title: string;
  glyph: MiniatureGlyph;
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * The card body for each resource type. A dashboard's body is the miniature
 * of itself: its widgets as placed tiles (empty when the transcript created
 * none, and the card stays header-only).
 */
export type ResourceCardBody =
  | { kind: "widget"; chips: string[]; chart: WidgetChart | null }
  | { kind: "dashboard"; tiles: MiniatureTile[] }
  | { kind: "receipt"; rows: ReceiptRow[] }
  | { kind: "detector"; chips: string[] };

export interface ResourceCardModel {
  resourceType: CardResourceType;
  resourceId: string;
  /** false when the write was idempotent and an existing resource was reused. */
  created: boolean;
  title: string;
  /** Parts of the small header meta line, joined by the renderer. */
  meta: string[];
  body: ResourceCardBody;
}

/** At most this many trigger conditions get their own chip; the rest are counted. */
const MAX_TRIGGER_CHIPS = 3;

/**
 * Caps on what a card prints. The panel is narrow and a chip is one line, so a
 * model-supplied name long enough to dominate the transcript is cut here rather
 * than left to the layout.
 */
const MAX_TITLE_CHARS = 120;
const MAX_VALUE_CHARS = 64;

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
 * What the card needs to draw the widget the model just created, or null when
 * it can't be drawn. The spec goes through the dashboard's own schema, so the
 * preview runs exactly the spec a dashboard tile would — a trace feed's spec
 * (rows and filters, no view or metric) fails that parse, which is why a feed
 * card keeps its chips and never queries.
 *
 * The project comes from the structured details, not the arguments: it is the
 * scope the write actually landed in, and a query is aimed by it.
 */
function widgetChart(
  args: Record<string, unknown>,
  details: ResourceCreatedDetails,
): WidgetChart | null {
  // Not str(): this id addresses a request rather than being printed, so it is
  // checked but never capped.
  const projectId = typeof details.projectId === "string" ? details.projectId.trim() : "";
  if (projectId === "") return null;
  const spec = parseSpec(args.spec);
  return spec === null ? null : { projectId, spec };
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
 * A detector's settings as chips. Whether the prompt is the template's or the
 * model's own leads, because that is the choice most worth catching.
 */
function detectorChips(args: Record<string, unknown>): string[] {
  const chips = [str(args.prompt) === null ? "template prompt" : "custom prompt"];
  if (typeof args.sample_rate === "number" && Number.isFinite(args.sample_rate)) {
    chips.push(`sample ${args.sample_rate}%`);
  }
  if (typeof args.enable_rca === "boolean") chips.push(args.enable_rca ? "RCA on" : "RCA off");
  if (args.enabled === false) chips.push("disabled");

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
 * The glyph a miniature tile draws for one created widget. A trace feed is
 * list rows; a chart widget is the shape of its display type, read loosely —
 * the glyph needs only `spec.display.type`, so a spec the full schema would
 * reject can still show its shape. Anything unreadable is a neutral tile.
 */
function tileGlyph(args: Record<string, unknown> | null): MiniatureGlyph {
  if (args === null) return "unknown";
  if (str(args.type) === "trace_feed") return "trace_feed";
  const display = plainObject(plainObject(args.spec)?.display);
  const displayType = display === null ? null : str(display.type);
  return (DISPLAY_TYPES as readonly string[]).includes(displayType ?? "")
    ? (displayType as DisplayType)
    : "unknown";
}

/**
 * A dashboard's widgets as miniature tiles, placed by folding each creation
 * (in transcript order) through the same placement function the widget create
 * route uses — so the miniature and the real grid cannot disagree. An
 * unreadable type falls back to a chart tile, the smaller of the two sizes;
 * a replayed create (same widget id twice) keeps its first tile.
 */
function dashboardTiles(steps: readonly ToolCallStep[]): MiniatureTile[] {
  let layout: WidgetPlacement[] = [];
  const tiles: MiniatureTile[] = [];
  for (const step of steps) {
    const details = resourceCreatedDetails(step.result);
    if (details === null) continue;
    const args = plainObject(step.args);
    const rawType = args?.type;
    const type: WidgetType = isWidgetType(rawType) ? rawType : "query";
    const next = appendWidgetPlacement(layout, { id: details.resourceId, type });
    if (next === null) continue;
    layout = next;
    const { x, y, w, h } = layout[layout.length - 1];
    tiles.push({
      id: details.resourceId,
      title: (args === null ? null : str(args.title)) ?? str(details.resourceId) ?? "",
      glyph: tileGlyph(args),
      x,
      y,
      w,
      h,
    });
  }
  return tiles;
}

/** "failure" -> "Failure" when it names a standard template; the raw id otherwise. */
function templateLabel(template: string): string {
  return DETECTOR_TEMPLATES.find((t) => t.id === template)?.label ?? template;
}

function body(
  resourceType: CardResourceType,
  args: Record<string, unknown> | null,
  details: ResourceCreatedDetails,
  widgetSteps: readonly ToolCallStep[],
): ResourceCardBody {
  switch (resourceType) {
    case "widget":
      if (args === null) return { kind: "widget", chips: [], chart: null };
      return { kind: "widget", chips: widgetChips(args), chart: widgetChart(args, details) };
    case "dashboard":
      return { kind: "dashboard", tiles: dashboardTiles(widgetSteps) };
    case "detector":
      return { kind: "detector", chips: args === null ? [] : detectorChips(args) };
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
 * the card's count and its miniature; see createdWidgetsByDashboard.
 */
export function resourceCardModel(
  step: ToolCallStep,
  widgetsByDashboard?: ReadonlyMap<string, readonly ToolCallStep[]>,
): ResourceCardModel | null {
  const details = resourceCreatedDetails(step.result);
  if (details === null || !isCardResourceType(details.resourceType)) return null;
  const resourceType = details.resourceType;

  const args = plainObject(step.args);
  // Widgets carry a title; everything else carries a name. Neither survives an
  // unreadable payload, so the id — always present — stands in for the name.
  const displayName =
    args === null ? null : (str(args.title, MAX_TITLE_CHARS) ?? str(args.name, MAX_TITLE_CHARS));

  const cardBody = body(
    resourceType,
    args,
    details,
    widgetsByDashboard?.get(details.resourceId) ?? [],
  );

  const meta: string[] = [RESOURCE_TYPE_LABELS[resourceType]];
  // A chart is a number without context until the window it covers is named.
  if (cardBody.kind === "widget" && cardBody.chart !== null) meta.push(DEFAULT_RANGE_LABEL);
  if (resourceType === "dashboard") {
    const widgetCount = widgetsByDashboard?.get(details.resourceId)?.length ?? 0;
    if (widgetCount > 0) meta.push(widgetCount === 1 ? "1 widget" : `${widgetCount} widgets`);
  }
  if (resourceType === "detector" && args !== null) {
    const template = str(args.template);
    if (template !== null) meta.push(templateLabel(template));
  }

  return {
    resourceType,
    resourceId: details.resourceId,
    created: details.created !== false,
    title: displayName ?? str(details.resourceId, MAX_TITLE_CHARS) ?? "",
    meta,
    body: cardBody,
  };
}

/**
 * The widget steps of a transcript, grouped by the dashboard each was added to.
 *
 * The dashboard's own call never says how many widgets it will hold — the
 * widgets are separate calls that land after it — so the transcript is the only
 * place that count exists without going back to the server for it.
 */
/**
 * The ids of tool-step messages whose widget card would duplicate a dashboard
 * card shown earlier in the same transcript: the dashboard's miniature already
 * draws every widget the transcript created into it, so those steps keep the
 * plain tool line instead of a second card. A widget whose dashboard has no
 * card here — created into a pre-existing dashboard — keeps its full card,
 * because that card is the only receipt there is.
 *
 * A dashboard has a card exactly when its resource_created step is present,
 * and only a dashboard step that PRECEDES the widget's suppresses it (the
 * agent creates the dashboard before filling it, so anything else is a widget
 * whose dashboard card the reader has not seen).
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
      dashboardCards.add(details.resourceId);
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
    // convention the miniature applies — otherwise the dashboard meta would
    // count one widget twice while the miniature draws a single tile.
    if (seen.has(details.resourceId)) continue;
    seen.add(details.resourceId);
    const siblings = byDashboard.get(details.dashboardId);
    if (siblings === undefined) byDashboard.set(details.dashboardId, [step]);
    else siblings.push(step);
  }
  return byDashboard;
}
