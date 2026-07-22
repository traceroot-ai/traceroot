/**
 * Parsing helpers for the span `events` blob (normalized OTEL span events).
 *
 * The backend stores events as a JSON array of {name, timestamp, attributes}
 * (see backend/worker/otel_transform.py:extract_span_events). Exception events
 * — emitted by record_exception() in both SDKs — carry the failure's
 * type/message/stacktrace and power the error panel.
 */

export interface SpanEvent {
  name: string;
  /** ISO-8601 timestamp, or null when the emitter sent none. */
  timestamp: string | null;
  attributes: Record<string, unknown>;
}

export interface ExceptionInfo {
  type: string | null;
  message: string | null;
  stacktrace: string | null;
}

/**
 * Parse the raw `events` blob into a list of span events.
 *
 * Defensive: a null/malformed blob or non-array JSON yields [], and entries
 * that are not objects are dropped — the panel must never crash on old rows
 * or hand-crafted payloads.
 */
export function parseSpanEvents(raw: string | null | undefined): SpanEvent[] {
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed
    .filter((e): e is Record<string, unknown> => typeof e === "object" && e !== null)
    .map((e) => ({
      name: typeof e.name === "string" ? e.name : "",
      timestamp: typeof e.timestamp === "string" ? e.timestamp : null,
      attributes:
        typeof e.attributes === "object" && e.attributes !== null
          ? (e.attributes as Record<string, unknown>)
          : {},
    }));
}

/** The exception events of a span, mapped to their type/message/stacktrace. */
export function getExceptionInfos(events: SpanEvent[]): ExceptionInfo[] {
  return events
    .filter((e) => e.name === "exception")
    .map((e) => ({
      type: asString(e.attributes["exception.type"]),
      message: asString(e.attributes["exception.message"]),
      stacktrace: asString(e.attributes["exception.stacktrace"]),
    }))
    .filter((info) => info.type !== null || info.message !== null || info.stacktrace !== null);
}

/** One-line "Type: message" label for an exception (either half optional). */
export function exceptionLabel(info: ExceptionInfo): string {
  if (info.type && info.message) return `${info.type}: ${info.message}`;
  return info.type ?? info.message ?? "Exception";
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}
