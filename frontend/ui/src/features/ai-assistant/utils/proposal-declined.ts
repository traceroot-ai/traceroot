/**
 * The `proposal_declined` details a declined confirm-class write carries on
 * its tool result: the user (or a server-side release) skipped the call, or
 * the user asked for changes. Lets the panel label the outcome directly
 * instead of inferring a skip from an error landing on a pending step.
 */
export interface ProposalDeclined {
  outcome: "skipped" | "revised";
  /** The user's requested changes (outcome "revised" only). */
  text?: string;
}

/**
 * Read the decline from a tool result's structured details, or null when the
 * result is not a declined proposal (or is malformed). Details arrive as
 * untyped JSON — over the stream live, out of a metadata column from history —
 * so every read is guarded.
 */
export function proposalDeclined(result: unknown): ProposalDeclined | null {
  if (typeof result !== "object" || result === null) return null;
  const details = (result as { details?: unknown }).details;
  if (typeof details !== "object" || details === null) return null;
  const d = details as Record<string, unknown>;
  if (d.kind !== "proposal_declined") return null;
  if (d.outcome !== "skipped" && d.outcome !== "revised") return null;
  return { outcome: d.outcome, ...(typeof d.text === "string" ? { text: d.text } : {}) };
}
