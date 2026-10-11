/**
 * Per-project, per-browser persistence for which traces the user has opened — the read/unread
 * state the list paints as a leading dot. There is no server-side per-user read state, so this
 * is deliberately local: the same browser that opened the trace is the one that reads it, and
 * nothing about it needs to follow the user across devices.
 *
 * `ids` is most-recently-viewed FIRST. The order is what makes the cap meaningful: trimming to
 * `MAX_VIEWED_TRACES` drops the traces a user has not looked at in the longest, not an arbitrary
 * slice. The entry is live in every tab on the project and can be hand-edited, so a read is never
 * trusted — `normalizeViewedTraces` is the one gate, and anything it cannot recognise reads as
 * "nothing viewed" rather than reaching the list.
 */

const STORAGE_VERSION = 1;

/**
 * How many viewed ids to keep per project. localStorage is a few MB and a trace id is tens of
 * characters, so the cap exists to bound growth for a long-lived project rather than to fit a
 * quota: at this size the entry stays well under 100 KB, and reaching it means a user opened this
 * many distinct traces, by which point the oldest are long out of the retention window.
 */
export const MAX_VIEWED_TRACES = 2000;

/** The stored shape. `ids` is unvalidated on the way in — see the header. */
export interface StoredViewedTraces {
  version: number;
  /** Viewed trace ids, most recently viewed first. */
  ids: string[];
}

/** The entry a project starts from: nothing viewed. */
export const NO_VIEWED_TRACES: StoredViewedTraces = { version: STORAGE_VERSION, ids: [] };

const NO_VIEWED_IDS: string[] = [];

export function viewedTracesKey(projectId: string): string {
  return `traceroot:traces:viewed:v${STORAGE_VERSION}:${projectId}`;
}

// The one gate every read passes through. Deduping and the cap belong here, not at the writes:
// a duplicate or an over-long list can arrive from another tab or a hand-edited entry, bypassing
// the mutators. First occurrence wins, so the surviving entry keeps its recency position.
export function normalizeViewedTraces(stored: unknown): string[] {
  if (typeof stored !== "object" || stored === null || Array.isArray(stored)) return NO_VIEWED_IDS;
  const { ids } = stored as Partial<StoredViewedTraces>;
  if (!Array.isArray(ids)) return NO_VIEWED_IDS;
  const seen = new Set<string>();
  const result: string[] = [];
  for (const id of ids) {
    if (typeof id !== "string" || id === "" || seen.has(id)) continue;
    seen.add(id);
    result.push(id);
  }
  return result.slice(0, MAX_VIEWED_TRACES);
}

export function toStoredViewedTraces(ids: readonly string[]): StoredViewedTraces {
  return { version: STORAGE_VERSION, ids: [...ids] };
}

/**
 * Mark one trace viewed, returning the new most-recent-first list. An id already at the front is
 * left in place (a re-render that re-marks the open trace must not churn storage); one seen
 * earlier moves to the front. The result is capped, so the oldest viewings fall off the end.
 */
export function addViewedTrace(current: readonly string[], traceId: string): string[] {
  if (traceId === "") return [...current];
  if (current[0] === traceId) return [...current];
  return [traceId, ...current.filter((id) => id !== traceId)].slice(0, MAX_VIEWED_TRACES);
}

/** How many extra read-merge passes run when a concurrent tab's write is detected. */
const MAX_MERGE_ATTEMPTS = 2;

/** The storage the merge reads and writes, so it can be exercised without a browser. */
export interface ViewedTraceStorage {
  read: () => string[];
  write: (ids: string[]) => void;
}

/**
 * Merge one trace into the viewed set on storage and return the merged list.
 *
 * localStorage has no compare-and-set, so two tabs can interleave a read-modify-write and the
 * later write drops the earlier tab's trace (its dot comes back). The read and the write here are
 * kept synchronous and adjacent, so the window is a single tick rather than a whole React commit,
 * and a bounded re-read then merges back whatever a racing tab landed on disk. This is best-effort
 * by nature: it closes the common race, not a write that lands after the final re-read.
 */
export function mergeViewedTrace(storage: ViewedTraceStorage, traceId: string): string[] {
  const current = storage.read();
  if (current[0] === traceId) return current;
  let merged = addViewedTrace(current, traceId);
  storage.write(merged);
  for (let attempt = 0; attempt < MAX_MERGE_ATTEMPTS; attempt++) {
    const onDisk = storage.read();
    if (merged.every((id) => onDisk.includes(id))) break;
    // Re-front `traceId`: a racing tab already at the cap would fill the first slots of the union,
    // and the cap would then drop the very trace being marked. Keeping it first drops the oldest
    // id instead, which is what the cap is for.
    merged = Array.from(new Set([traceId, ...onDisk, ...merged])).slice(0, MAX_VIEWED_TRACES);
    storage.write(merged);
  }
  return merged;
}
