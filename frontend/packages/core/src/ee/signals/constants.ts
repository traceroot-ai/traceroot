/**
 * Signals contract shared by the worker (assignment, RCA, digest), the UI routes
 * and, by mirroring, the Python public API. Status and reason values are stored
 * as plain strings; these lists are the allowlist.
 */

export const SIGNAL_STATUSES = ["open", "resolved", "dismissed"] as const;
export type SignalStatus = (typeof SIGNAL_STATUSES)[number];

/** Why a user resolved a signal. "other" requires a note. */
export const RESOLVE_REASONS = [
  "fixed_elsewhere",
  "fixed_by_pr",
  "already_fixed_before",
  "other",
] as const;
export type ResolveReason = (typeof RESOLVE_REASONS)[number];

/** Why a user dismissed a signal. "other" requires a note. */
export const DISMISS_REASONS = [
  "unclear",
  "rca_wrong",
  "grouped_wrong",
  "expected_behavior",
  "duplicate",
  "already_fixed",
  "low_impact",
  "other",
] as const;
export type DismissReason = (typeof DISMISS_REASONS)[number];

/** Upper bound on a status note; matches the UI's textarea limit. */
export const SIGNAL_NOTE_MAX_LENGTH = 4000;

/** actorUserId and reason recorded when a new hit reopens a resolved signal. */
export const SYSTEM_ACTOR = "system";
export const SYSTEM_REOPEN_REASON = "new_hit";

/** BullMQ queue that runs one assignment job per (project, detector) partition. */
export const SIGNAL_ASSIGN_QUEUE = "signal-assign";

/**
 * Deterministic job id for a partition's assignment job, so every hit in a
 * partition enqueues the same job and at most one runs at a time. BullMQ accepts
 * a custom id containing ":" only when it splits into exactly three parts, so
 * neither id may contain ":" (cuids and project ids never do).
 */
export function signalAssignJobId(projectId: string, detectorId: string): string {
  if (!projectId || !detectorId || projectId.includes(":") || detectorId.includes(":")) {
    throw new Error(`invalid signal partition: ${projectId}/${detectorId}`);
  }
  return `assign:${projectId}:${detectorId}`;
}
