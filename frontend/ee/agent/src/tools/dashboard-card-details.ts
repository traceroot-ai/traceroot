/**
 * The structured `details` the widget and dashboard reads attach beside their
 * text, for the chat panel's cards. A compact projection rather than the
 * payload: the card draws each widget with the dashboards feature's own query
 * hook, so it needs the definition (id, title, type, spec, placement) and the
 * window, never the rows — and a persisted tool step caps each metadata value,
 * so rows would not survive a reload anyway.
 */

import type { QueryWindow } from "./query-window.js";

/**
 * The window a card is drawn over. A data read carries the window the server
 * answered for (bounds always set, `range` null for explicit bounds); a
 * definition read carries the page's window the agent was given, which may be
 * a preset alone with no bounds. Null when neither said.
 */
export interface CardWindow {
  range: string | null;
  start_time: string | null;
  end_time: string | null;
  clamped: boolean;
}

/** One widget as a card draws it, with its answer's status on a data read. */
export interface CardWidget {
  id: string;
  title: string;
  type: string;
  spec: unknown;
  /** The data read's status; null on a definition read, which answers nothing. */
  status: "ok" | "skipped" | "error" | null;
  error: string | null;
}

/** One widget's place on the dashboard grid, in grid units. */
export interface CardPlacement {
  i: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface DashboardReadCardDetails {
  kind: "dashboard_read";
  dashboard: { id: string; name: string };
  window: CardWindow | null;
  widgets: CardWidget[];
  /** The stored grid placement, or null when the read did not report one. */
  layout: CardPlacement[] | null;
}

export interface WidgetReadCardDetails {
  kind: "widget_read";
  widget: CardWidget & { dashboard_id: string; dashboard_name: string | null };
  window: CardWindow | null;
}

/**
 * The most a dashboard card's details may weigh, serialized. A persisted tool
 * step shares 8 KB between its args, its text and these details; past this
 * the details are left off and the panel keeps the plain tool line, rather
 * than a history row cut partway through the widget list redrawing a
 * different dashboard on reload.
 */
export const DASHBOARD_CARD_DETAILS_MAX_BYTES = 5_000;

/** A widget error is one line of the card; a longer reason is cut. */
const MAX_ERROR_CHARS = 300;

/** A string field, or null: an absent or non-string value never becomes text. */
function text(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function status(value: unknown): CardWidget["status"] {
  return value === "ok" || value === "skipped" || value === "error" ? value : null;
}

function cardError(value: unknown): string | null {
  const error = text(value);
  return error === null || error.length <= MAX_ERROR_CHARS
    ? error
    : `${error.slice(0, MAX_ERROR_CHARS)}…`;
}

/** The widget projection, or null when it has no id to stand on. */
function cardWidget(widget: unknown): CardWidget | null {
  if (!isRecord(widget)) return null;
  const id = text(widget.id);
  if (id === null) return null;
  return {
    id,
    title: text(widget.title) ?? "",
    type: text(widget.type) ?? "",
    spec: widget.spec ?? null,
    status: status(widget.status),
    error: cardError(widget.error),
  };
}

/** The window a data read echoes, or null when the payload carries none. */
function answeredWindow(value: unknown): CardWindow | null {
  if (!isRecord(value)) return null;
  const start = text(value.start_time);
  const end = text(value.end_time);
  if (start === null || end === null) return null;
  return {
    range: text(value.range),
    start_time: start,
    end_time: end,
    clamped: value.clamped === true,
  };
}

/** The page's window, for a definition read that answers for no window of its own. */
function pageWindow(window: QueryWindow | undefined): CardWindow | null {
  if (window === undefined) return null;
  if (window.range !== undefined) {
    return { range: window.range, start_time: null, end_time: null, clamped: false };
  }
  if (window.start_time !== undefined && window.end_time !== undefined) {
    return {
      range: null,
      start_time: window.start_time,
      end_time: window.end_time,
      clamped: false,
    };
  }
  return null;
}

/** The placements that are placements; anything else in the column is dropped. */
function placements(value: unknown): CardPlacement[] | null {
  if (!Array.isArray(value)) return null;
  const out: CardPlacement[] = [];
  for (const entry of value) {
    if (!isRecord(entry) || typeof entry.i !== "string") continue;
    const coords = [entry.x, entry.y, entry.w, entry.h];
    if (!coords.every((n) => typeof n === "number" && Number.isInteger(n) && n >= 0)) continue;
    const [x, y, w, h] = coords as number[];
    out.push({ i: entry.i, x, y, w, h });
  }
  return out;
}

function withinBudget(details: DashboardReadCardDetails): DashboardReadCardDetails | undefined {
  const bytes = Buffer.byteLength(JSON.stringify(details), "utf8");
  return bytes <= DASHBOARD_CARD_DETAILS_MAX_BYTES ? details : undefined;
}

function dashboardDetails(
  dashboard: unknown,
  widgets: unknown,
  layout: unknown,
  window: CardWindow | null,
): DashboardReadCardDetails | undefined {
  if (!isRecord(dashboard) || !Array.isArray(widgets)) return undefined;
  const id = text(dashboard.id);
  if (id === null) return undefined;
  const cards = widgets.map(cardWidget);
  // A widget the projection cannot read would leave a hole the card cannot
  // place, so the dashboard is not carded at all rather than drawn wrong.
  if (cards.some((card) => card === null)) return undefined;
  return withinBudget({
    kind: "dashboard_read",
    dashboard: { id, name: text(dashboard.name) ?? "" },
    window,
    widgets: cards as CardWidget[],
    layout: placements(layout),
  });
}

/**
 * Card details for a get_dashboard payload, drawn over the page's window (the
 * read itself answers for none), or undefined when the payload is not a
 * dashboard — the panel then keeps the plain tool line.
 */
export function dashboardDetailCardDetails(
  data: unknown,
  window: QueryWindow | undefined,
): DashboardReadCardDetails | undefined {
  if (!isRecord(data)) return undefined;
  return dashboardDetails(data, data.widgets, data.layout, pageWindow(window));
}

/** Card details for a get_dashboard_data payload, drawn over the window it answered for. */
export function dashboardDataCardDetails(data: unknown): DashboardReadCardDetails | undefined {
  if (!isRecord(data)) return undefined;
  return dashboardDetails(data.dashboard, data.widgets, data.layout, answeredWindow(data.window));
}

function widgetDetails(
  widget: unknown,
  answer: Record<string, unknown> | null,
  window: CardWindow | null,
): WidgetReadCardDetails | undefined {
  if (!isRecord(widget)) return undefined;
  const card = cardWidget(answer === null ? widget : { ...widget, ...answer });
  const dashboardId = text(widget.dashboard_id);
  if (card === null || dashboardId === null) return undefined;
  return {
    kind: "widget_read",
    widget: { ...card, dashboard_id: dashboardId, dashboard_name: text(widget.dashboard_name) },
    window,
  };
}

/** Card details for a get_widget payload, drawn over the page's window. */
export function widgetDetailCardDetails(
  data: unknown,
  window: QueryWindow | undefined,
): WidgetReadCardDetails | undefined {
  return widgetDetails(data, null, pageWindow(window));
}

/** Card details for a get_widget_data payload, drawn over the window it answered for. */
export function widgetDataCardDetails(data: unknown): WidgetReadCardDetails | undefined {
  if (!isRecord(data)) return undefined;
  // Only the answer's status and reason join the widget's identity; its rows
  // stay out of the card's details.
  return widgetDetails(
    data.widget,
    { status: data.status, error: data.error },
    answeredWindow(data.window),
  );
}
