/**
 * Presentation for the registry-driven read tools: renders parsed API
 * responses into the text the model sees. Moved verbatim from the former
 * hand-rolled query tools so the model-visible output is unchanged.
 */

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
  const meta = (body.meta || {}) as { total?: number; next_cursor?: string };

  if (!Array.isArray(detectors) || detectors.length === 0) {
    return "No detectors found.";
  }

  const lines = detectors.map((d: any) => {
    const state = d.enabled ? "enabled" : "disabled";
    return `- ${d.detector_id} | ${d.name || "(unnamed)"} | template: ${d.template || "none"} | ${state} | created ${d.created_at || "unknown"}`;
  });

  const totalInfo = meta.total ? ` (${meta.total} total, showing ${detectors.length})` : "";
  const more = meta.next_cursor
    ? `\nMore results available — call again with cursor="${meta.next_cursor}" to continue.`
    : "";

  return `Found ${detectors.length} detectors${totalInfo}:\n${lines.join("\n")}${more}`;
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
  const meta = (body.meta || {}) as { total?: number; next_cursor?: string };

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
  const more = meta.next_cursor
    ? `\nMore results available — call again with cursor="${meta.next_cursor}" to continue.`
    : "";

  return `Found ${findings.length} findings${totalInfo}:\n${lines.join("\n")}${more}`;
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
