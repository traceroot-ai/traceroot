/**
 * The agent service's one internal credential.
 *
 * REST and the UI accept two internal secrets: the platform one
 * (`INTERNAL_API_SECRET`: worker, Next.js server) and this one. Their privilege
 * is the same; what differs is the `source` the trace ingest route stamps, so
 * a process holding only the agent secret can neither forge a detector trace
 * nor be affected by a platform-secret rotation (design: agent-self-trace,
 * decision 2). That holds only while the agent sends this secret on every
 * internal call, hence one accessor rather than six env reads.
 */
export function agentInternalSecret(): string {
  return process.env.INTERNAL_API_SECRET_AGENT || "";
}
