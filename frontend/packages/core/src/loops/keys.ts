/**
 * Names and keys of a Loop's hidden detector and its signals. Every finding a
 * Loop records becomes a hit of that detector, so every signal it creates
 * carries `detectorId` and the signal's provenance needs no column of its own.
 * The detector never runs on ingest, outlives its Loop so that Loop's signals
 * still read as a deleted Loop's, and every reader of user detectors filters
 * with USER_DETECTOR_WHERE. The template and the name prefix are reserved: a
 * user detector may take neither. Pure: safe in the browser.
 */
import type { Prisma } from "@prisma/client";

export const LOOP_DETECTOR_TEMPLATE = "loop";
const LOOP_DETECTOR_NAME_PREFIX = "loop:";

/**
 * The detectors a user manages: every detector but the Loops' hidden ones.
 * The Python REST reader (backend/rest/services/detector_reader.py) keeps the
 * same filter.
 */
export const USER_DETECTOR_WHERE = {
  template: { not: LOOP_DETECTOR_TEMPLATE },
} satisfies Prisma.DetectorWhereInput;

/** The detector's name: unique per project because the Loop's name is. */
export function loopDetectorName(loopName: string): string {
  return `${LOOP_DETECTOR_NAME_PREFIX}${loopName}`;
}

/** The name a deleted Loop's detector keeps, freeing "loop:<name>" for a new Loop. */
export function deletedLoopDetectorName(detectorId: string): string {
  return `${LOOP_DETECTOR_NAME_PREFIX}deleted:${detectorId}`;
}

/**
 * Why a user detector may not have this template or name, or null when it may.
 * A user detector with the Loop template would be hidden from every read, and
 * one named "loop:<name>" would take the name of that Loop's hidden detector.
 */
export function reservedDetectorProblem(fields: {
  template?: string;
  name?: string;
}): string | null {
  if (fields.template === LOOP_DETECTOR_TEMPLATE) {
    return `template "${LOOP_DETECTOR_TEMPLATE}" is reserved for loops`;
  }
  if (fields.name?.startsWith(LOOP_DETECTOR_NAME_PREFIX)) {
    return `name must not start with "${LOOP_DETECTOR_NAME_PREFIX}", which is reserved for loops`;
  }
  return null;
}

/**
 * What a Loop signal's group key starts with. The same text as the hidden
 * detector's name prefix, but a separate thing: one names a detector, the
 * other keys a signal.
 */
export const LOOP_GROUP_KEY_PREFIX = "loop:";

/**
 * A Loop signal's group key: its finding key behind LOOP_GROUP_KEY_PREFIX. A run lists
 * the finding keys it recorded, so the key links a signal to the runs that found it.
 *
 * The runner's contract (the signal panel's "Seen in N runs" reads it):
 * - Every signal a Loop creates has this group key, built from the finding's key.
 *   A signal without one is linked to no run.
 * - Every run that records finding X, or re-confirms an existing X, lists X once in
 *   `LoopRun.findingKeys` (no duplicates, so the run count is the number of runs).
 * - A merged signal keeps its group key: `mergeSignals` (ee/signals/edits.ts) only
 *   sets `mergedIntoId` on the source row, and the partial unique index on
 *   (project_id, detector_id, group_key) stops a new row taking the key. So when the
 *   runner finds X's signal with `mergedIntoId` set, it follows `mergedIntoId` to the
 *   live signal and adds the hit there, and still lists X in the run's findingKeys.
 *   Runs are matched to a signal by its own key only, so the target's panel lists
 *   the runs of its own key, not those of the keys merged into it.
 */
export function loopSignalGroupKey(findingKey: string): string {
  return `${LOOP_GROUP_KEY_PREFIX}${findingKey}`;
}

/** The finding key inside a Loop signal's group key; null for any other signal. */
export function findingKeyOfGroupKey(groupKey: string | null): string | null {
  return groupKey?.startsWith(LOOP_GROUP_KEY_PREFIX)
    ? groupKey.slice(LOOP_GROUP_KEY_PREFIX.length) || null
    : null;
}
