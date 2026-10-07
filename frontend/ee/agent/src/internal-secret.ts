/**
 * The internal credential the agent service presents on server-to-server calls.
 *
 * One value for every internal caller (worker, Next.js server, this service).
 * A trace's `source` is decided by the ingest path the agent posts to
 * (`/api/v1/internal/traces/agent`), not by which credential authenticated —
 * the label separates reading and billing, not privilege, so a second secret
 * to configure and rotate bought nothing (design: decision 2).
 *
 * One accessor rather than an env read per call site, so the value every tool
 * sends is the one the self-trace exporter sends.
 */
export function agentInternalSecret(): string {
  return process.env.INTERNAL_API_SECRET || "";
}
