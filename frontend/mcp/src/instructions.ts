/**
 * What the server tells an assistant when it connects. Short, because it is
 * read on every connection: what this is, what a call can and cannot see, and
 * the habits that avoid the common failures. Some clients never show it to the
 * model, so the same essentials live in the tool descriptions too.
 */
export const SERVER_INSTRUCTIONS = [
  "TraceRoot records what AI agents do: traces (one run), their spans, sessions, findings raised by detectors, alerts, dashboards, datasets and evaluation runs.",
  "These tools read one project's data, the project the connection was granted for, and they cannot change anything. There is no project argument.",
  "Look ids up instead of guessing them: use the list_* tools (list_traces, list_sessions, list_findings, list_detectors, list_alerts, list_dashboards, list_datasets) to find an id, then the get_* tool for detail.",
  "Time windows are ISO 8601 timestamps. List results are paged: use a small limit, and read the paging fields in the result to ask for the next page.",
  "get_trace returns a trace's structure by default and leaves out the trace-level input, output and metadata, which can be large; ask for them through its fields argument only when needed.",
  "run_sql answers a question the other tools do not, with a read-only query: call get_sql_schema first to see the tables and columns.",
  'A result over the size limit is shortened but stays JSON: a cut value ends in "…[truncated N chars]", _truncated counts dropped list items by path, and _hint says how to ask for less. Credentials found in trace data are replaced with [REDACTED] and named in _redactedKeys.',
  "If a call is refused with an authentication error, the user's connection was revoked or their key is wrong; ask them to reconnect rather than retrying.",
].join("\n");
