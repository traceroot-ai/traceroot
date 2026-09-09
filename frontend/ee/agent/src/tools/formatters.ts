/**
 * Presentation for the registry-driven read tools: renders parsed API
 * responses into the text the model sees. Moved verbatim from the former
 * hand-rolled query tools so the model-visible output is unchanged.
 */

import { truncateHead } from "./truncate.js";

/** Render a trace list response as the summary table text. */
export function formatTraceList(data: unknown): string {
  const body = (data ?? {}) as { data?: unknown; meta?: unknown };
  // FastAPI returns { data: TraceListItem[], meta: { page, limit, total } }
  const traces = (body.data || []) as any[];
  const meta = (body.meta || {}) as { total?: number };

  if (!Array.isArray(traces) || traces.length === 0) {
    return "No traces found matching the given filters.";
  }

  // Format as summary table for the agent
  const lines = traces.map((t: any) => {
    const duration = t.duration_ms != null ? `${Math.round(t.duration_ms)}ms` : "?";
    return `- ${t.trace_id} | ${t.name || "(unnamed)"} | ${t.trace_start_time} | ${t.error_count ?? 0} errors | ${t.span_count} spans | ${duration}`;
  });

  const totalInfo = meta.total ? ` (${meta.total} total, showing ${traces.length})` : "";

  return `Found ${traces.length} traces${totalInfo}:\n${lines.join("\n")}`;
}

/** Truncate to at most `max` UTF-16 units without splitting a surrogate pair. */
function truncate(value: string, max: number): string {
  if (value.length <= max) {
    return value;
  }
  const cut = value.slice(0, max);
  // A trailing high surrogate means the cut split a pair; dropping it keeps
  // the output valid Unicode instead of emitting a lone surrogate.
  const last = cut.charCodeAt(cut.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
}

/** Render a session detail response as the overview plus per-trace I/O text. */
export function formatSessionDetail(data: unknown): string {
  const body = (data ?? {}) as any;
  const traces: any[] = body.traces || [];

  if (traces.length === 0) {
    return `Session ${body.session_id} has no traces.`;
  }

  const durationStr = body.duration_ms != null ? `${Math.round(body.duration_ms)}ms` : "unknown";
  const userStr = (body.user_ids || []).join(", ") || "none";

  const traceLines = traces.map((t: any, i: number) => {
    const dur = t.duration_ms != null ? `${Math.round(t.duration_ms)}ms` : "?";
    const inp = t.input ? truncate(t.input, 200) : "(none)";
    const out = t.output ? truncate(t.output, 200) : "(none)";
    return [
      `#${i + 1} ${t.trace_id} — ${t.name || "(unnamed)"} | ${t.status} | ${dur}`,
      `   Input:  ${inp}`,
      `   Output: ${out}`,
    ].join("\n");
  });

  return [
    `Session: ${body.session_id}`,
    `Traces: ${body.trace_count} | Duration: ${durationStr} | Users: ${userStr}`,
    ``,
    traceLines.join("\n\n"),
  ].join("\n");
}

/** Render a session list response as the per-session summary lines. */
export function formatSessionList(data: unknown): string {
  const body = (data ?? {}) as { data?: unknown };
  const sessions: any[] = (body.data || []) as any[];

  if (sessions.length === 0) {
    return "No sessions found.";
  }

  const lines = sessions.map((s: any) => {
    const dur = s.duration_ms != null ? `${Math.round(s.duration_ms)}ms` : "?";
    return `- ${s.session_id} | ${s.trace_count} traces | ${dur} | users: ${(s.user_ids || []).join(", ") || "none"}`;
  });

  return `Found ${sessions.length} sessions:\n${lines.join("\n")}`;
}

/** Render a detector list response as per-detector summary lines. */
export function formatDetectorList(data: unknown): string {
  const body = (data ?? {}) as { data?: unknown; meta?: unknown };
  const detectors = (body.data || []) as any[];
  const meta = (body.meta || {}) as { total?: number };

  if (!Array.isArray(detectors) || detectors.length === 0) {
    return "No detectors found.";
  }

  const lines = detectors.map((d: any) => {
    const state = d.enabled ? "enabled" : "disabled";
    return `- ${d.detector_id} | ${d.name || "(unnamed)"} | template: ${d.template || "none"} | ${state} | created ${d.created_at || "unknown"}`;
  });

  const totalInfo = meta.total ? ` (${meta.total} total, showing ${detectors.length})` : "";

  return `Found ${detectors.length} detectors${totalInfo}:\n${lines.join("\n")}`;
}

/** Render one detector's full configuration for the model. */
export function formatDetectorDetail(data: unknown): string {
  const d = (data ?? {}) as any;
  const state = d.enabled ? "enabled" : "disabled";
  const rca = d.enable_rca ? "on" : "off";
  const sample = d.sample_rate != null ? `${d.sample_rate}%` : "unknown";
  const model = d.detection_model || "default";
  const detection = d.detection_provider ? `${model} via ${d.detection_provider}` : model;
  const source = d.detection_source || "unknown";

  const header = [
    `Detector: ${d.detector_id} | ${d.name || "(unnamed)"}`,
    `Template: ${d.template || "none"} | ${state} | sample rate: ${sample} | RCA: ${rca}`,
    `Detection: ${detection} (${source}) | created ${d.created_at || "unknown"} | updated ${d.updated_at || "unknown"}`,
  ];

  const prompt = d.prompt ? truncate(d.prompt, 1000) : "(none)";
  const schema =
    d.output_schema != null ? truncate(JSON.stringify(d.output_schema), 400) : "(none)";
  // No trigger row means the detector gates on nothing beyond its sample rate.
  const trigger =
    d.trigger_conditions != null
      ? truncate(JSON.stringify(d.trigger_conditions), 400)
      : "(none — runs on every sampled trace)";

  return [
    ...header,
    "",
    `Prompt: ${prompt}`,
    `Output schema: ${schema}`,
    `Trigger conditions: ${trigger}`,
  ].join("\n");
}

/** Render a finding list response as per-finding summary lines. */
export function formatFindingList(data: unknown): string {
  const body = (data ?? {}) as { data?: unknown; meta?: unknown };
  const findings = (body.data || []) as any[];
  const meta = (body.meta || {}) as { total?: number };

  if (!Array.isArray(findings) || findings.length === 0) {
    return "No detector findings found matching the given filters.";
  }

  const lines = findings.map((f: any) => {
    const detectors = (f.detectors || []).join(", ") || "unknown";
    return [
      `- ${f.finding_id} | trace ${f.trace_id} | ${f.timestamp} | detectors: ${detectors}`,
      `  ${truncate(f.summary || "(no summary)", 200)}`,
    ].join("\n");
  });

  const totalInfo = meta.total ? ` (${meta.total} total, showing ${findings.length})` : "";

  return `Found ${findings.length} findings${totalInfo}:\n${lines.join("\n")}`;
}

/** Render a finding detail: header, per-detector results, then the RCA text. */
export function formatFindingDetail(data: unknown): string {
  const f = (data ?? {}) as any;
  const detectors = (f.detectors || []).join(", ") || "unknown";

  const header = [
    `Finding: ${f.finding_id}`,
    `Trace: ${f.trace_id} | Time: ${f.timestamp} | Detectors: ${detectors}`,
    `Summary: ${f.summary || "(no summary)"}`,
  ];

  const results: any[] = f.results || [];
  const resultBlocks = results.map((r: any, i: number) => {
    const detail = r.data != null ? truncate(JSON.stringify(r.data), 400) : "(none)";
    return [
      `#${i + 1} ${r.detector_name || r.detector_id} (template: ${r.template || "none"})`,
      `   ${r.summary || "(no summary)"}`,
      `   Data: ${detail}`,
    ].join("\n");
  });
  const resultsSection =
    resultBlocks.length > 0
      ? ["", "Per-detector results:", resultBlocks.join("\n")]
      : ["", "Per-detector results: (none)"];

  // A pending/failed RCA is stated explicitly so the model doesn't invent one;
  // "yet" only fits a pending RCA, not a failed one.
  const rcaPlaceholder = f.rca?.status === "pending" ? "(no RCA text yet)" : "(no RCA text)";
  const rcaSection = f.rca
    ? ["", `RCA (${f.rca.status}):`, f.rca.result || rcaPlaceholder]
    : ["", "RCA: none recorded for this finding."];

  return [...header, ...resultsSection, ...rcaSection].join("\n");
}

/** Render a dashboard list response as the catalog lines. */
export function formatDashboardList(data: unknown): string {
  const body = (data ?? {}) as { data?: unknown };
  const dashboards = (body.data || []) as any[];

  if (!Array.isArray(dashboards) || dashboards.length === 0) {
    return "No dashboards found in this project.";
  }

  const lines = dashboards.map((d: any) => {
    const marker = d.is_default ? " (default)" : "";
    const description = d.description ? ` — ${truncate(String(d.description), 200)}` : "";
    return `- ${d.id} | ${d.name || "(unnamed)"}${marker} | ${d.widget_count ?? 0} widgets | by ${d.creator ?? "unknown"}${description}`;
  });

  return `Found ${dashboards.length} dashboards:\n${lines.join("\n")}`;
}

/** Render a dashboard detail response as the overview plus per-widget spec lines. */
export function formatDashboardDetail(data: unknown): string {
  const d = (data ?? {}) as any;
  const widgets: any[] = Array.isArray(d.widgets) ? d.widgets : [];

  const header = [
    `Dashboard: ${d.id} | ${d.name || "(unnamed)"}${d.is_default ? " (default)" : ""}`,
    `Created by ${d.creator ?? "unknown"} | created ${d.create_time ?? "unknown"} | updated ${d.update_time ?? "unknown"}`,
    `Description: ${d.description || "(none)"}`,
  ].join("\n");

  if (widgets.length === 0) {
    return `${header}\n\nWidgets: (none — add one with create_widget)`;
  }

  const widgetLines = widgets.map((w: any, i: number) => {
    const spec = w.spec != null ? truncate(JSON.stringify(w.spec), 500) : "(none)";
    return `#${i + 1} ${w.id} | ${w.title || "(untitled)"} | type: ${w.type ?? "unknown"}\n   Spec: ${spec}`;
  });

  return `${header}\n\nWidgets (${widgets.length}):\n${widgetLines.join("\n")}`;
}

// ── dashboard data reads ─────────────────────────────────────────────────────

/** Rows a single widget's answer shows before the rest is summarized away. */
const WIDGET_ROW_CAP = 25;
/** Bytes one dashboard's answer may occupy in the transcript. */
const DASHBOARD_DATA_BUDGET_BYTES = 16 * 1024;

function formatNumber(value: unknown): string {
  if (typeof value === "number") {
    if (Number.isInteger(value)) return value.toLocaleString("en-US");
    return value.toLocaleString("en-US", { maximumFractionDigits: 2 });
  }
  if (typeof value === "string") {
    // Decimal columns arrive as strings; render them like numbers.
    const n = Number(value);
    if (value.trim() !== "" && Number.isFinite(n)) return formatNumber(n);
    return value;
  }
  if (value === null || value === undefined) return "—";
  return String(value);
}

/** One line naming the window an answer was computed for — always shown, so a figure is never window-less. */
export function formatWindow(window: unknown): string {
  const w = (window ?? {}) as {
    start_time?: string;
    end_time?: string;
    range?: string | null;
    clamped?: boolean;
  };
  const label = w.range ? `range ${w.range}` : "explicit bounds";
  const clamped = w.clamped ? " — start clamped to the plan's retention cutoff" : "";
  return `Window: ${label} (${w.start_time ?? "?"} → ${w.end_time ?? "?"})${clamped}`;
}

function isTimeSeries(
  columns: string[],
  meta: Record<string, unknown> | undefined,
  rows: unknown[][],
): boolean {
  if (meta?.granularity !== undefined) return true;
  const first = rows[0]?.[0];
  return columns.length >= 2 && typeof first === "string" && /^\d{4}-\d{2}-\d{2}T/.test(first);
}

/**
 * A cell as a number, or null when it carries no value. The engine emits
 * real NULLs for the empty buckets of an average or percentile series (a gap,
 * not a zero) and '' on the breakdown column of its filled rows; neither may
 * become a figure. Decimal columns arrive as strings and count.
 */
function toValue(cell: unknown): number | null {
  if (cell === null || cell === undefined || cell === "") return null;
  const n = typeof cell === "number" ? cell : typeof cell === "string" ? Number(cell) : Number.NaN;
  return Number.isFinite(n) ? n : null;
}

/**
 * min | max (with the bucket it fell in) | latest over the buckets that carry
 * a value; honest about an empty last bucket. A partial series (the server
 * capped its rows) has no latest: its last returned bucket is not the window's.
 */
function seriesStats(
  values: Array<number | null>,
  labels: string[],
  partial = false,
  lastOpen = false,
): string {
  const present = values.filter((v): v is number => v !== null);
  if (present.length === 0) return "no values in any bucket";
  const max = Math.max(...present);
  const peak = `max ${formatNumber(max)} (${labels[values.indexOf(max)]})`;
  const min = `min ${formatNumber(Math.min(...present))}`;
  if (partial) return `${min} | ${peak} over the returned rows (partial)`;
  const last = values[values.length - 1];
  const latest =
    last === null
      ? `latest bucket empty (last value ${formatNumber(present[present.length - 1])})`
      : `latest ${formatNumber(last)}${lastOpen ? ` ${PARTIAL_NOTE}` : ""}`;
  return `${min} | ${peak} | ${latest}`;
}

/**
 * A long single series is sampled from its ends: this many from the head and
 * the tail, plus this many of its largest buckets wherever they fall. A series
 * is read for anomalies as often as for trend, and the anomaly is almost never
 * at either end — a sample that were only the two ends would hide the very
 * bucket a "when did it spike" question is about, and the reader would have no
 * way to tell it was hidden.
 */
const HEAD_ROWS = 3;
const TAIL_ROWS = 5;
const OUTLIER_ROWS = 3;
const SAMPLE_ROWS = HEAD_ROWS + TAIL_ROWS;

/** How many series a breakdown-over-time answer shows before the rest is counted. */
const SERIES_CAP = 10;

/** Rendering options a caller knows and the rows do not say. */
interface RowsOptions {
  /** The server capped the rows: a series is partial, and its trend stats say so. */
  truncated?: boolean;
  /** The window the rows were answered for; names a number tile's range and marks a still-open last bucket. */
  window?: { start_time?: string; end_time?: string };
}

/**
 * Whether the last bucket of a series is still in progress at the window's
 * end: its interval, at the series' granularity, runs past the window. A
 * bucket label is a naive UTC instant ("2026-09-08T00:00:00").
 */
function lastBucketOpen(
  labels: string[],
  meta: Record<string, unknown> | undefined,
  window: RowsOptions["window"],
): boolean {
  const last = labels[labels.length - 1];
  const end = window?.end_time;
  const granularity = meta?.granularity;
  // No granularity, no verdict: the engine names one for every series it
  // builds, so its absence means this is not a series the engine bucketed.
  if (last === undefined || end === undefined || granularity === undefined) return false;
  const granule = /hour|^\d+h$/i.test(String(granularity)) ? 3_600_000 : 86_400_000;
  const bucketStart = Date.parse(/[zZ]|[+-]\d{2}:\d{2}$/.test(last) ? last : `${last}Z`);
  const windowEnd = Date.parse(end);
  if (!Number.isFinite(bucketStart) || !Number.isFinite(windowEnd)) return false;
  return bucketStart + granule > windowEnd;
}

const PARTIAL_NOTE = "(partial: bucket still in progress)";

function formatSeries(
  columns: string[],
  rows: unknown[][],
  meta?: Record<string, unknown>,
  options: RowsOptions = {},
): string {
  const partial = options.truncated === true;
  const granularity =
    meta?.granularity !== undefined ? ` | granularity ${String(meta.granularity)}` : "";
  const valueIndex = columns.length - 1;
  if (columns.length >= 3) {
    // [bucket, <breakdown>, value]: one line per series, keyed by bucket so a
    // series with no row in a bucket reads as empty there rather than
    // borrowing its neighbour's position. The engine's filled rows carry ''
    // in the breakdown column and belong to no series, but their bucket is
    // still a bucket.
    const buckets = [...new Set(rows.map((r) => String(r[0])))];
    const lastOpen = lastBucketOpen(buckets, meta, options.window);
    const byGroup = new Map<string, Map<string, number | null>>();
    for (const r of rows) {
      const key = r[1];
      if (key === "" || key === null || key === undefined) continue;
      const cells = byGroup.get(String(key)) ?? new Map<string, number | null>();
      cells.set(String(r[0]), toValue(r[valueIndex]));
      byGroup.set(String(key), cells);
    }
    const ranked = [...byGroup.entries()]
      .map(([key, cells]) => {
        const values = buckets.map((bucket) => cells.get(bucket) ?? null);
        return { key, values, peak: Math.max(...values.map((v) => v ?? -Infinity)) };
      })
      .sort((a, b) => b.peak - a.peak);
    const shown = ranked
      .slice(0, SERIES_CAP)
      .map(({ key, values }) => `  ${key}: ${seriesStats(values, buckets, partial, lastOpen)}`);
    const more =
      ranked.length > SERIES_CAP ? [`  … ${ranked.length - SERIES_CAP} more series`] : [];
    const first = buckets[0];
    const last = buckets[buckets.length - 1];
    return [
      `${buckets.length} buckets × ${byGroup.size} series (${columns.join(", ")})${granularity}, ${String(first)} → ${String(last)}`,
      ...shown,
      ...more,
    ].join("\n");
  }
  const values = rows.map((r) => toValue(r[valueIndex]));
  const labels = rows.map((r) => String(r[0]));
  const lastOpen = lastBucketOpen(labels, meta, options.window);
  // The still-open last bucket is marked on its own line too, so a reader who
  // skips the stats line cannot take a low final value for a drop.
  const line = (r: unknown[]) =>
    `  ${String(r[0])}  ${formatNumber(r[valueIndex])}${lastOpen && r === rows[rows.length - 1] ? " (partial)" : ""}`;
  // A long series where only a few buckets carry a value shows exactly those
  // buckets, with the rest counted: a 90-day window with one spike is the
  // spike's date, not eight zeros from either end. A short series shows every
  // bucket; a long dense one (or one with nothing in it) shows its ends and
  // its peaks.
  // A measured 0 and an empty bucket are counted apart — for an average or a
  // rate, 0 is a value, and the note must not read as "no data".
  const carrying = rows.filter((_, i) => values[i] !== null && values[i] !== 0);
  const sparse = rows.length > SAMPLE_ROWS && carrying.length > 0 && carrying.length <= SAMPLE_ROWS;
  const zeros = values.filter((v) => v === 0).length;
  const empties = values.filter((v) => v === null).length;
  const omitted = [
    ...(zeros > 0 ? [`${zeros} buckets at 0`] : []),
    ...(empties > 0 ? [`${empties} empty`] : []),
  ].join(" and ");
  // A long dense series shows its head, its tail and its largest buckets, in
  // chronological order, with each remaining stretch collapsed to its own note.
  // The peaks cost at most three lines and keep the sample honest: whatever is
  // elided is bounded above by a bucket the reader can see.
  const denseSample = (): string[] => {
    if (rows.length <= SAMPLE_ROWS) return rows.map(line);
    const keep = new Set<number>();
    for (let i = 0; i < HEAD_ROWS; i += 1) keep.add(i);
    for (let i = rows.length - TAIL_ROWS; i < rows.length; i += 1) keep.add(i);
    // A slot goes only to a bucket larger than anything the head and tail
    // already show: a flat series has no outliers, and ties at the baseline
    // would otherwise spend the slots on more of the same.
    const visibleMax = Math.max(...[...keep].map((index) => values[index] ?? -Infinity));
    const byValue = values
      .map((value, index) => ({ value, index }))
      .filter((entry): entry is { value: number; index: number } => entry.value !== null)
      .filter(({ value, index }) => !keep.has(index) && value > visibleMax)
      .sort((a, b) => b.value - a.value || a.index - b.index)
      .slice(0, OUTLIER_ROWS);
    for (const { index } of byValue) keep.add(index);
    const lines: string[] = [];
    let skipped = 0;
    // An elision names the stretch it swallowed: the dates it spans and the
    // values inside it. A bare count would leave the reader unable to tell a
    // flat hidden stretch from one holding a second, smaller anomaly, and no
    // way to date the run's edges except by guessing from the neighbouring
    // lines. `at` is the index the elision ends before, so the elided rows are
    // [at - skipped, at).
    const flush = (at: number) => {
      if (skipped > 0) {
        const elided = rows.slice(at - skipped, at);
        const span = `${String(elided[0][0])} → ${String(elided[elided.length - 1][0])}`;
        const inside = values.slice(at - skipped, at);
        const present = inside.filter((v): v is number => v !== null);
        const summary =
          present.length === 0
            ? "all empty"
            : present.length === inside.length && present.every((v) => v === present[0])
              ? `all ${formatNumber(present[0])}`
              : `min ${formatNumber(Math.min(...present))} | max ${formatNumber(Math.max(...present))}`;
        lines.push(`  … ${skipped} more buckets ${span}, ${summary} …`);
      }
      skipped = 0;
    };
    for (let i = 0; i < rows.length; i += 1) {
      if (!keep.has(i)) {
        skipped += 1;
        continue;
      }
      flush(i);
      lines.push(line(rows[i]));
    }
    flush(rows.length);
    return lines;
  };
  const sample = sparse ? [...carrying.map(line), `  … ${omitted} not shown`] : denseSample();
  return [
    `${rows.length} buckets (${columns.join(", ")})${granularity}`,
    `  ${seriesStats(values, labels, partial, lastOpen)}`,
    ...sample,
  ].join("\n");
}

/**
 * Render one query result: a short table for breakdowns, a shape summary for
 * a time series (min/max/latest, then every bucket of a short series, the
 * carrying buckets of a long sparse one, or the ends and the peaks of a long
 * dense one —
 * the model needs the trend, not every bucket; one stats line per series for
 * a breakdown over time), the single value for a number display.
 */
export function formatRows(
  columns: string[],
  rows: unknown[][],
  meta?: Record<string, unknown>,
  options: RowsOptions = {},
): string {
  if (rows.length === 0) return "No rows in this window.";
  if (columns.length === 1 && rows.length === 1) {
    // An aggregate over nothing comes back as ONE row holding NULL, not zero
    // rows, so the empty-result sentence above never fires for a number tile.
    // Say the window is empty in words: a bare dash is the same glyph a null
    // cell inside a table gets, and the model should not have to read a glyph
    // to tell "no data" from "0". Tested on null/undefined rather than through
    // toValue() so a legitimately non-numeric single value is not mislabelled.
    // Labelled as the whole window's value: an aggregate is one figure for a
    // range, not the last point of a series. The bounds themselves are on the
    // window line every result starts with.
    const w = options.window;
    const range = w?.start_time !== undefined && w.end_time !== undefined ? " (whole window)" : "";
    const only = rows[0][0];
    if (only === null || only === undefined) {
      return `${columns[0]}${range}: — (no rows in this window)`;
    }
    return `${columns[0]}${range}: ${formatNumber(only)}`;
  }
  if (isTimeSeries(columns, meta, rows)) return formatSeries(columns, rows, meta, options);
  const shown = rows.slice(0, WIDGET_ROW_CAP);
  const lines = shown.map(
    (r) => `  ${r.map((v, i) => (i === 0 ? String(v ?? "—") : formatNumber(v))).join("  |  ")}`,
  );
  const more =
    rows.length > shown.length ? [`  … ${rows.length - shown.length} more rows not shown`] : [];
  return [`${rows.length} rows (${columns.join(", ")})`, ...lines, ...more].join("\n");
}

/** The text the model sees for a run_widget_query result. */
export function formatWidgetQueryResult(data: unknown): string {
  const d = (data ?? {}) as {
    columns?: string[];
    rows?: unknown[][];
    meta?: Record<string, unknown>;
    window?: unknown;
  };
  const columns = Array.isArray(d.columns) ? d.columns : [];
  const rows = Array.isArray(d.rows) ? d.rows : [];
  const window = d.window as RowsOptions["window"];
  return [formatWindow(d.window), formatRows(columns, rows, d.meta, { window })].join("\n");
}

/** What a caller can add to a dashboard read that the payload itself does not carry. */
export interface DashboardDataOptions {
  /** The dashboard's page URL for an id, when the caller knows the site's origin and the project. */
  dashboardUrl?: (dashboardId: string) => string;
}

const OVER_BUDGET_NOTE =
  "  rows not included: the dashboard read is over its text budget — run this widget's spec with run_widget_query";

/**
 * The text the model sees for a get_dashboard_data result: the counts and
 * the window first, then one block per widget in the dashboard's order.
 *
 * Space is spent rows-first: every widget always keeps its title and status
 * line, so the model knows what the dashboard holds even when it cannot
 * quote from all of it. Each widget's body is added, in dashboard order, if
 * the text still fits with it; a widget whose body does not fit says how to
 * get its rows, and a smaller one after it may still fit. Only when the
 * widget list alone does not fit is the text cut, with a marker.
 */
export function formatDashboardData(data: unknown, options: DashboardDataOptions = {}): string {
  const d = (data ?? {}) as any;
  const dash = d.dashboard ?? {};
  const widgets: any[] = Array.isArray(d.widgets) ? d.widgets : [];
  const window = d.window as RowsOptions["window"];
  const url =
    typeof dash.id === "string" && options.dashboardUrl
      ? [`URL: ${options.dashboardUrl(dash.id)}`]
      : [];
  const head = [
    `Dashboard: ${dash.id ?? "?"} | ${dash.name || "(unnamed)"}${dash.is_default ? " (default)" : ""}`,
    ...url,
    formatWindow(d.window),
    `${d.queried ?? 0} widgets queried, ${d.skipped ?? 0} feeds skipped, ${d.failed ?? 0} failed`,
    "",
  ];
  const blocks = widgets.map((w, i) => {
    const title = `#${i + 1} ${w.title || "(untitled)"} | ${w.type ?? "unknown"} | ${w.status}`;
    if (w.status === "skipped") {
      return {
        title,
        body: "  feed — not summarized; read it with list_traces and the feed's filters",
        fixed: true,
      };
    }
    if (w.status === "error") {
      return { title, body: `  error: ${w.error ?? "unknown"}`, fixed: true };
    }
    const rows = formatRows(
      Array.isArray(w.columns) ? w.columns : [],
      Array.isArray(w.rows) ? w.rows : [],
      w.meta ?? undefined,
      { truncated: w.truncated === true, window },
    );
    const capped = w.truncated
      ? "\n  (rows capped by the server — run this widget's spec with run_widget_query for every row)"
      : "";
    return { title, body: `${rows}${capped}`, fixed: false };
  });
  const bytes = (text: string) => Buffer.byteLength(text, "utf-8");
  // The floor every widget costs whatever happens: its title with its
  // one-line status, or its title with the over-budget note. Bodies are then
  // swapped in for notes, in order, while the whole text still fits.
  const floor = (b: { title: string; body: string; fixed: boolean }) =>
    b.fixed ? `${b.title}\n${b.body}` : `${b.title}\n${OVER_BUDGET_NOTE}`;
  let used = bytes([...head, ...blocks.map(floor)].join("\n"));
  const rendered = blocks.map((b) => {
    if (b.fixed) return floor(b);
    const delta = bytes(b.body) - bytes(OVER_BUDGET_NOTE);
    // A body no longer than the note always fits; it is the note's replacement.
    if (delta <= 0 || used + delta <= DASHBOARD_DATA_BUDGET_BYTES) {
      used += delta;
      return `${b.title}\n${b.body}`;
    }
    return floor(b);
  });
  const text = [...head, ...rendered].join("\n");
  const bounded = truncateHead(text, { maxBytes: DASHBOARD_DATA_BUDGET_BYTES });
  return bounded.truncated
    ? `${bounded.content}\n… output truncated at ${DASHBOARD_DATA_BUDGET_BYTES} bytes; read the dashboard with get_dashboard for a widget's spec, then run_widget_query for that widget`
    : bounded.content;
}
