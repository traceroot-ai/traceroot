/**
 * The structured `details` the alert reads attach beside their text, for the
 * chat panel's cards. A compact projection rather than the payload: a
 * persisted tool step caps each metadata value, and a list of fifty alerts
 * with every timestamp and error string would not survive a reload.
 */

/** The alert fields a card row needs: the rule, and the state the badge reads. */
export interface AlertCardRow {
  id: string;
  name: string;
  view: string | null;
  measure: string | null;
  aggregation: string | null;
  window: string | null;
  threshold_operator: string | null;
  threshold: number | null;
  status: string | null;
  severity: string | null;
  alerted_at: string | null;
  last_evaluated_at: string | null;
  last_error: string | null;
  last_notify_status: string | null;
  last_notify_error: string | null;
  last_notify_at: string | null;
}

/** The detail card adds the rest of the rule and the facts its panel lists. */
export interface AlertCardDetail extends AlertCardRow {
  filters: unknown[];
  renotify: unknown;
  no_data_mode: string | null;
  severity_changed_at: string | null;
  creator: string | null;
  create_time: string | null;
}

export interface AlertListCardDetails {
  kind: "alert_list";
  alerts: AlertCardRow[];
  /** Alerts in the project, from the payload's paging meta (the page's own length when absent). */
  total: number;
  capacity: { used: number; max: number } | null;
}

export interface AlertDetailCardDetails {
  kind: "alert_detail";
  alert: AlertCardDetail;
}

/**
 * Rows one list card carries. The text the model reads still lists every
 * row the page returned; the card is a picture of the first few, and says
 * how many more there are.
 */
export const ALERT_CARD_ROW_CAP = 20;

/** A string field, or null: an absent or non-string value never becomes text. */
function text(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/** A finite number, or null. */
function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The row projection, or null when the alert has no id or name to stand on. */
function cardRow(alert: unknown): AlertCardRow | null {
  if (!isRecord(alert)) return null;
  const id = text(alert.id);
  const name = text(alert.name);
  if (id === null || name === null) return null;
  return {
    id,
    name,
    view: text(alert.view),
    measure: text(alert.measure),
    aggregation: text(alert.aggregation),
    window: text(alert.window),
    threshold_operator: text(alert.threshold_operator),
    threshold: num(alert.threshold),
    status: text(alert.status),
    severity: text(alert.severity),
    alerted_at: text(alert.alerted_at),
    last_evaluated_at: text(alert.last_evaluated_at),
    last_error: text(alert.last_error),
    last_notify_status: text(alert.last_notify_status),
    last_notify_error: text(alert.last_notify_error),
    last_notify_at: text(alert.last_notify_at),
  };
}

/**
 * Card details for a list_alerts payload, or undefined when the payload is
 * not a list — the panel then keeps the plain tool line. Rows the projection
 * cannot read are dropped rather than carded half-empty.
 */
export function alertListCardDetails(data: unknown): AlertListCardDetails | undefined {
  if (!isRecord(data) || !Array.isArray(data.data)) return undefined;
  const meta = isRecord(data.meta) ? data.meta : {};
  const rows = data.data.map(cardRow).filter((row): row is AlertCardRow => row !== null);
  const capacity = isRecord(meta.capacity) ? meta.capacity : null;
  const used = capacity === null ? null : num(capacity.used);
  const max = capacity === null ? null : num(capacity.max);
  return {
    kind: "alert_list",
    alerts: rows.slice(0, ALERT_CARD_ROW_CAP),
    total: num(meta.total) ?? rows.length,
    capacity: used === null || max === null ? null : { used, max },
  };
}

/** Card details for a get_alert payload, or undefined when it is not an alert. */
export function alertDetailCardDetails(data: unknown): AlertDetailCardDetails | undefined {
  const row = cardRow(data);
  if (row === null) return undefined;
  const alert = data as Record<string, unknown>;
  return {
    kind: "alert_detail",
    alert: {
      ...row,
      filters: Array.isArray(alert.filters) ? alert.filters : [],
      renotify: isRecord(alert.renotify) ? alert.renotify : null,
      no_data_mode: text(alert.no_data_mode),
      severity_changed_at: text(alert.severity_changed_at),
      creator: text(alert.creator),
      create_time: text(alert.create_time),
    },
  };
}
