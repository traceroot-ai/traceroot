/** Presentation for the Loop agent's reads that the chat agent does not offer. */
import { truncateHead } from "../truncate.js";

/** Spans shown per trace; a longer trace says how many were left out. */
export const TRACE_SPAN_CAP = 200;
/** Characters kept of each span's input, output and status message. */
const SPAN_TEXT_CHARS = 400;
/** The whole rendering stays within this, whatever the trace holds. */
const TRACE_TEXT_BYTES = 40 * 1024;

interface SpanRow {
  span_id?: string;
  parent_span_id?: string | null;
  name?: string;
  span_kind?: string;
  span_start_time?: string;
  span_end_time?: string | null;
  status?: string;
  status_message?: string | null;
  error_type?: string;
  model_name?: string | null;
  cost?: number | null;
  input_tokens?: number | null;
  output_tokens?: number | null;
  input?: string | null;
  output?: string | null;
}

/** Cut to at most `max` UTF-16 units without splitting a surrogate pair. */
export function clip(value: string, max: number): string {
  if (value.length <= max) return value;
  let cut = value.slice(0, max);
  const last = cut.charCodeAt(cut.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1);
  return `${cut}… (${value.length - cut.length} more chars)`;
}

function durationMs(span: SpanRow): string {
  if (!span.span_start_time || !span.span_end_time) return "?";
  const ms = Date.parse(span.span_end_time) - Date.parse(span.span_start_time);
  return Number.isFinite(ms) ? `${Math.round(ms)}ms` : "?";
}

/** One trace as an indented span tree: status, timing, model and errors per span. */
export function formatTraceDetail(data: unknown): string {
  const body = (data ?? {}) as {
    trace_id?: string;
    name?: string;
    trace_start_time?: string;
    session_id?: string | null;
    user_id?: string | null;
    input?: string | null;
    output?: string | null;
    spans?: SpanRow[];
  };
  const spans = Array.isArray(body.spans) ? body.spans : [];
  const lines = [
    `Trace ${body.trace_id} — ${body.name || "(unnamed)"} | started ${body.trace_start_time ?? "?"}` +
      ` | session ${body.session_id ?? "none"} | user ${body.user_id ?? "none"} | ${spans.length} spans`,
  ];
  if (body.input) lines.push(`Input: ${clip(body.input, SPAN_TEXT_CHARS)}`);
  if (body.output) lines.push(`Output: ${clip(body.output, SPAN_TEXT_CHARS)}`);

  const ids = new Set(spans.map((s) => s.span_id));
  const children = new Map<string | null, SpanRow[]>();
  for (const span of spans) {
    // A parent outside the trace (or missing) makes the span a root.
    const parent = span.parent_span_id && ids.has(span.parent_span_id) ? span.parent_span_id : null;
    const list = children.get(parent) ?? [];
    list.push(span);
    children.set(parent, list);
  }
  for (const list of children.values()) {
    list.sort((a, b) => (a.span_start_time ?? "").localeCompare(b.span_start_time ?? ""));
  }

  let shown = 0;
  const seen = new Set<SpanRow>();
  const walk = (parent: string | null, depth: number) => {
    for (const span of children.get(parent) ?? []) {
      if (shown >= TRACE_SPAN_CAP) return;
      if (seen.has(span)) continue;
      seen.add(span);
      shown += 1;
      const pad = "  ".repeat(depth);
      const parts = [
        `${pad}- ${span.name || "(unnamed)"} [${span.span_kind ?? "?"}]`,
        span.status ?? "?",
        durationMs(span),
      ];
      if (span.model_name) parts.push(span.model_name);
      if (span.input_tokens != null || span.output_tokens != null) {
        parts.push(`${span.input_tokens ?? 0} in / ${span.output_tokens ?? 0} out tokens`);
      }
      if (span.error_type) parts.push(`error ${span.error_type}`);
      lines.push(parts.join(" | "));
      if (span.status_message) {
        lines.push(`${pad}  status: ${clip(span.status_message, SPAN_TEXT_CHARS)}`);
      }
      if (span.input) lines.push(`${pad}  in: ${clip(span.input, SPAN_TEXT_CHARS)}`);
      if (span.output) lines.push(`${pad}  out: ${clip(span.output, SPAN_TEXT_CHARS)}`);
      if (span.span_id) walk(span.span_id, depth + 1);
    }
  };
  walk(null, 0);
  if (shown < spans.length) {
    lines.push(`(${spans.length - shown} more spans not shown)`);
  }
  const out = truncateHead(lines.join("\n"), { maxBytes: TRACE_TEXT_BYTES });
  return out.truncated ? `${out.content}\n(trace text truncated)` : out.content;
}
