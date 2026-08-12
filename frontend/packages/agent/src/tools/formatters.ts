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

/** Render a metadata-keys response as one key-per-line with occurrence counts. */
export function formatMetadataKeys(data: unknown): string {
  const body = (data ?? {}) as { keys?: unknown };
  const keys = (body.keys || []) as any[];

  if (!Array.isArray(keys) || keys.length === 0) {
    return "No metadata keys found on this project's traces or spans.";
  }

  const lines = keys.map((k: any) => `- ${k.value} (${k.count} occurrences)`);
  return `Metadata keys on this project's traces and spans (by frequency):\n${lines.join("\n")}\nUse one as the "key" of a metadata filter on list_traces.`;
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
