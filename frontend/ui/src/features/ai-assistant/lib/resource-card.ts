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
import { resolveSiteRange } from "@/features/dashboards/range-presets";
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
import { resourceCreatedDetails, type ResourceCreatedDetails } from "./resource-created";
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
 * What one tile of the dashboard miniature shows: the widget's name, the glyph
 * of its shape, its place on the real grid in grid units — and, when the
 * widget carries a runnable query, the query itself, so the tile can render
 * live data once the miniature scrolls into view. The glyph remains the tile's
 * loading and failure face: a feed, an unparseable spec, or a failed query
 * shows the shape rather than nothing.
 */
export type MiniatureGlyph = DisplayType | "trace_feed" | "unknown";

export interface MiniatureTile {
  id: string;
  title: string;
  glyph: MiniatureGlyph;
  /** The query behind the tile, or null when only the glyph can stand — a
   *  trace feed, a spec the widget schema rejects, or an unknown project. */
  chart: WidgetChart | null;
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
 * The card body for each resource type. A dashboard's body is the miniature
 * of itself: its widgets as placed tiles (empty when the transcript created
 * none, and the card stays header-only). A detector's body is its prompt —
 * the thing the detector actually is — over its settings chips.
 */
export type ResourceCardBody =
  | { kind: "widget"; chips: string[]; chart: WidgetChart | null }
  | { kind: "dashboard"; tiles: MiniatureTile[] }
  | { kind: "receipt"; rows: ReceiptRow[] }
  | { kind: "detector"; chips: string[]; prompt: DetectorPrompt | null };

export interface ResourceCardModel {
  resourceType: CardResourceType;
  resourceId: string;
  /** false when the write was idempotent and an existing resource was reused. */
  created: boolean;
  title: string;
  /** Parts of the small header meta line, joined by the renderer. */
  meta: string[];
  /** A description the args carried, when the type has nothing else to show
   *  (a pending dashboard — its widgets arrive as separate calls — or a
   *  reused dashboard, whose miniature cannot be trusted). */
  description?: string;
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
 * A detector's settings as chips: how much traffic it samples, whether RCA
 * runs, an explicit enabled/paused state, the model that judges, then the
 * trigger conditions in the detector editor's own vocabulary. The prompt is
 * not a chip — it is the card's body (see detectorPrompt).
 */
function detectorChips(args: Record<string, unknown>): string[] {
  const chips: string[] = [];
  if (typeof args.sample_rate === "number" && Number.isFinite(args.sample_rate)) {
    chips.push(`sample ${args.sample_rate}%`);
  }
  if (typeof args.enable_rca === "boolean") chips.push(args.enable_rca ? "RCA on" : "RCA off");
  if (typeof args.enabled === "boolean") chips.push(args.enabled ? "enabled" : "paused");
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
      // The same gate the widget card's own preview applies: a strict spec
      // parse plus the project the write landed in — a feed's spec fails the
      // parse, which is why a feed tile keeps its rows and never queries.
      chart: args === null ? null : widgetChart(args, details),
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
      // Only a freshly CREATED dashboard gets a miniature. A reused
      // (idempotent-hit) dashboard was laid out before this transcript
      // existed, so folding its new widgets through an empty layout would
      // draw tile positions the real grid never assigned — the card keeps
      // the count/description body instead.
      return {
        kind: "dashboard",
        tiles: details.created !== false ? dashboardTiles(widgetSteps) : [],
      };
    case "detector":
      return {
        kind: "detector",
        chips: args === null ? [] : detectorChips(args),
        prompt: args === null ? null : detectorPrompt(args),
      };
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
  // A chart is a number without context until the window it covers is named —
  // and the name must be the range the chart actually queries: the site's
  // stored selection for the chart's own project, default otherwise.
  if (cardBody.kind === "widget" && cardBody.chart !== null) {
    meta.push(resolveSiteRange(cardBody.chart.projectId).label);
  }
  if (resourceType === "dashboard") {
    const widgetCount = widgetsByDashboard?.get(details.resourceId)?.length ?? 0;
    if (widgetCount > 0) meta.push(widgetCount === 1 ? "1 widget" : `${widgetCount} widgets`);
    // One window label for the whole miniature — the tiles share a single
    // frozen range, so naming it per tile would be twelve copies of one fact.
    // Any charted tile names the project, the same way the miniature aims it.
    const chartedTile = cardBody.kind === "dashboard" ? cardBody.tiles.find((t) => t.chart) : null;
    if (chartedTile?.chart) meta.push(resolveSiteRange(chartedTile.chart.projectId).label);
  }
  if (resourceType === "detector" && args !== null) {
    const template = str(args.template);
    if (template !== null) meta.push(templateLabel(template));
  }

  // A reused dashboard draws no miniature (see body above), so its card gets
  // what the pending card shows: the description the call carried, if any.
  const description =
    resourceType === "dashboard" && details.created === false && args !== null
      ? str(args.description, MAX_DESCRIPTION_CHARS)
      : null;

  return {
    resourceType,
    resourceId: details.resourceId,
    created: details.created !== false,
    title: displayName ?? str(details.resourceId, MAX_TITLE_CHARS) ?? "",
    meta,
    ...(description === null ? {} : { description }),
    body: cardBody,
  };
}

/** The confirm-class write tools and the resource each would create. */
const PENDING_TOOL_RESOURCE_TYPES: Readonly<Record<string, CardResourceType>> = {
  create_widget: "widget",
  create_dashboard: "dashboard",
  create_project: "project",
  create_workspace: "workspace",
  create_detector: "detector",
};

/** A pending dashboard's description is prose, so it gets more room than a chip. */
const MAX_DESCRIPTION_CHARS = 200;

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
 * - a project or workspace is header-only (its id doesn't exist yet).
 * Null for a tool this panel has no card for; the caller keeps the plain tool
 * line, matching the receipt convention.
 */
export function pendingCardModel(
  step: ToolCallStep,
  panelProjectId: string | undefined,
): ResourceCardModel | null {
  const resourceType = PENDING_TOOL_RESOURCE_TYPES[step.toolName];
  if (resourceType === undefined) return null;

  const args = plainObject(step.args);
  const displayName =
    args === null ? null : (str(args.title, MAX_TITLE_CHARS) ?? str(args.name, MAX_TITLE_CHARS));

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
            : { projectId: panelProjectId, spec },
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
    default:
      // A project or workspace has no id yet, so there is no receipt to print.
      body = { kind: "receipt", rows: [] };
  }

  const meta: string[] = [RESOURCE_TYPE_LABELS[resourceType]];
  // The pending chart is aimed at the panel's project, so its window label
  // resolves against the same project — what the preview will really query.
  if (body.kind === "widget" && body.chart !== null) {
    meta.push(resolveSiteRange(body.chart.projectId).label);
  }
  if (resourceType === "detector" && args !== null) {
    const template = str(args.template);
    if (template !== null) meta.push(templateLabel(template));
  }

  const description =
    resourceType === "dashboard" && args !== null
      ? str(args.description, MAX_DESCRIPTION_CHARS)
      : null;

  return {
    resourceType,
    // The call's own id: unique and stable, it keys the chart preview's query
    // until the real widget id exists.
    resourceId: step.toolCallId,
    created: true,
    title: displayName ?? RESOURCE_TYPE_LABELS[resourceType],
    meta,
    ...(description === null ? {} : { description }),
    body,
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
      // Only a CREATED dashboard's card draws a miniature; a reused one has
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
