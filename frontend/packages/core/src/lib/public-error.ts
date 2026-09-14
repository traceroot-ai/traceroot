/**
 * Sanitises an error for a surface a customer can reach — an SSE `error`
 * frame, a persisted RCA `result`, the RCA route's JSON response — none of
 * which may carry a raw provider/database error verbatim: connection
 * strings, stack frames, and other internal detail can appear in
 * `Error.message`. Callers still log the original with `console.error` at
 * the point they catch it; this is only what gets shown.
 *
 * First line only (a multi-line message is usually a stack trace or a
 * provider dump past the first line), redacted the same way persisted tool
 * I/O is (see capture-policy.ts's redactSecrets), and capped well short of
 * a UI string.
 */
import { redactSecrets } from "./capture-policy.ts";

const PUBLIC_ERROR_CAP = 200;

export function publicErrorMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  const firstLine = raw.split("\n", 1)[0] ?? "";
  const redacted = redactSecrets(firstLine);
  return redacted.length > PUBLIC_ERROR_CAP ? `${redacted.slice(0, PUBLIC_ERROR_CAP)}…` : redacted;
}
