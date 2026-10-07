/**
 * The part of a finished OpenTelemetry span the predicate reads. Structural,
 * so the agent needs no dependency on @opentelemetry/sdk-trace-base: the SDK's
 * `ReadableSpan` satisfies it.
 */
export type FinishedSpan = { name: string; attributes: Record<string, unknown> };

/**
 * Whether a finished span is one the Daytona SDK opened on its own.
 *
 * The sandbox client instruments every method of its classes (`Daytona`,
 * `Sandbox`, `Process`, `FileSystem`, `Git`, …) with an OpenTelemetry
 * decorator that names the span `<Class>.<method>`, stamps `component` and
 * `method`, and records the HTTP status and duration — never the request or
 * the response. With a tracer registered in the agent process those spans
 * land in the agent's trace: ten of them around one `download_traces` (create
 * the sandbox, poll it up, upload three files) and one behind every `bash`,
 * each with an empty input and output, siblings of the tool span that already
 * carries the command and the result (they are opened outside the tool span's
 * context). A reader gains nothing from them and loses the shape of the run,
 * so the agent does not export them (decided with Xinwei, 2026-09-15).
 *
 * Recognised by the decorator's signature — the name is exactly
 * `${component}.${method}` — so a span the agent names itself, or one from
 * another library, is never mistaken for one of these.
 */
export function isSandboxClientSpan(span: FinishedSpan): boolean {
  const { component, method } = span.attributes;
  return (
    typeof component === "string" &&
    typeof method === "string" &&
    span.name === `${component}.${method}`
  );
}

/** The agent's `exportSpan` predicate: everything but the sandbox client's own spans. */
export function exportAgentSpan(span: FinishedSpan): boolean {
  return !isSandboxClientSpan(span);
}
