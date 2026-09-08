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

/** min | max | latest over the buckets that carry a value; honest about an empty last bucket. */
function seriesStats(values: Array<number | null>): string {
  const present = values.filter((v): v is number => v !== null);
  if (present.length === 0) return "no values in any bucket";
  const last = values[values.length - 1];
  const latest =
    last === null
      ? `latest bucket empty (last value ${formatNumber(present[present.length - 1])})`
      : `latest ${formatNumber(last)}`;
  return `min ${formatNumber(Math.min(...present))} | max ${formatNumber(Math.max(...present))} | ${latest}`;
}

/** How many series a breakdown-over-time answer shows before the rest is counted. */
const SERIES_CAP = 10;

function formatSeries(
  columns: string[],
  rows: unknown[][],
  meta?: Record<string, unknown>,
): string {
  const granularity =
    meta?.granularity !== undefined ? ` | granularity ${String(meta.granularity)}` : "";
  const valueIndex = columns.length - 1;
  if (columns.length >= 3) {
    // [bucket, <breakdown>, value]: one line per series. The engine's filled
    // rows carry '' in the breakdown column and belong to no series.
    const buckets = new Set(rows.map((r) => String(r[0])));
    const groups = new Map<string, Array<number | null>>();
    for (const r of rows) {
      const key = r[1];
      if (key === "" || key === null || key === undefined) continue;
      const list = groups.get(String(key)) ?? [];
      list.push(toValue(r[valueIndex]));
      groups.set(String(key), list);
    }
    const ranked = [...groups.entries()]
      .map(([key, values]) => ({
        key,
        values,
        peak: Math.max(...values.map((v) => v ?? -Infinity)),
      }))
      .sort((a, b) => b.peak - a.peak);
    const shown = ranked
      .slice(0, SERIES_CAP)
      .map(({ key, values }) => `  ${key}: ${seriesStats(values)}`);
    const more =
      ranked.length > SERIES_CAP ? [`  … ${ranked.length - SERIES_CAP} more series`] : [];
    const first = rows[0]?.[0];
    const last = rows[rows.length - 1]?.[0];
    return [
      `${buckets.size} buckets × ${groups.size} series (${columns.join(", ")})${granularity}, ${String(first)} → ${String(last)}`,
      ...shown,
      ...more,
    ].join("\n");
  }
  const values = rows.map((r) => toValue(r[valueIndex]));
  const line = (r: unknown[]) => `  ${String(r[0])}  ${formatNumber(r[valueIndex])}`;
  const head = rows.slice(0, 3).map(line);
  const tail = rows.length > 8 ? rows.slice(-5).map(line) : rows.slice(3).map(line);
  const gap = rows.length > 8 ? [`  … ${rows.length - 8} more buckets …`] : [];
  return [
    `${rows.length} buckets (${columns.join(", ")})${granularity}`,
    `  ${seriesStats(values)}`,
    ...head,
    ...gap,
    ...tail,
  ].join("\n");
}

/**
 * Render one query result: a short table for breakdowns, a shape summary for
 * a time series (first and last buckets plus min/max/latest — the model needs
 * the trend, not every bucket; one stats line per series for a breakdown over
 * time), the single value for a number display.
 */
export function formatRows(
  columns: string[],
  rows: unknown[][],
  meta?: Record<string, unknown>,
): string {
  if (rows.length === 0) return "No rows in this window.";
  if (columns.length === 1 && rows.length === 1) {
    return `${columns[0]}: ${formatNumber(rows[0][0])}`;
  }
  if (isTimeSeries(columns, meta, rows)) return formatSeries(columns, rows, meta);
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
  return [formatWindow(d.window), formatRows(columns, rows, d.meta)].join("\n");
}

/** The text the model sees for a get_dashboard_data result: one block per widget, then the counts. */
export function formatDashboardData(data: unknown): string {
  const d = (data ?? {}) as any;
  const dash = d.dashboard ?? {};
  const widgets: any[] = Array.isArray(d.widgets) ? d.widgets : [];
  const header = `Dashboard: ${dash.id ?? "?"} | ${dash.name || "(unnamed)"}${dash.is_default ? " (default)" : ""}`;
  const blocks = widgets.map((w, i) => {
    const title = `#${i + 1} ${w.title || "(untitled)"} | ${w.type ?? "unknown"} | ${w.status}`;
    if (w.status === "skipped") {
      return `${title}\n  feed — not summarized; read it with list_traces and the feed's filters`;
    }
    if (w.status === "error") {
      return `${title}\n  error: ${w.error ?? "unknown"}`;
    }
    const body = formatRows(
      Array.isArray(w.columns) ? w.columns : [],
      Array.isArray(w.rows) ? w.rows : [],
      w.meta ?? undefined,
    );
    const truncated = w.truncated ? "\n  (rows capped by the server)" : "";
    return `${title}\n${body}${truncated}`;
  });
  const counts = `${d.queried ?? 0} widgets queried, ${d.skipped ?? 0} feeds skipped, ${d.failed ?? 0} failed`;
  const text = [header, formatWindow(d.window), "", ...blocks, "", counts].join("\n");
  const bounded = truncateHead(text, { maxBytes: DASHBOARD_DATA_BUDGET_BYTES });
  return bounded.truncated
    ? `${bounded.content}\n… output truncated at ${DASHBOARD_DATA_BUDGET_BYTES} bytes; read the dashboard with get_dashboard for a widget's spec, then run_widget_query for that widget`
    : bounded.content;
}
