import { isFixedColumnId, type FixedColumnId } from "@/features/traces/columns";

/**
 * Per-project, per-browser persistence for the trace list's column selection.
 * The entry holds the ids whose visibility is FLIPPED from the registry default rather than
 * the ids that are shown, so a column added to the registry later reaches existing users
 * without a migration.
 *
 * The same entry is live in every tab on the project and can be hand-edited, so a read is
 * never trusted: `normalizeColumns` is the one gate, and anything it cannot recognise reads
 * as "no deviation from the defaults" instead of reaching the table. Unrecognised properties
 * on an otherwise valid entry are ignored, so an entry written by an older build keeps the
 * field choices it holds.
 */

const STORAGE_VERSION = 1;

/** The stored shape. `fields` is unvalidated on the way in — see the header. */
export interface StoredColumns {
  version: number;
  /** Ids whose visibility is FLIPPED from the registry default, not the ids that are shown. */
  fields: string[];
}

/** The entry a project starts from, and what a reset writes back. */
export const NO_COLUMNS: StoredColumns = { version: STORAGE_VERSION, fields: [] };

const NO_FIELDS: FixedColumnId[] = [];

export function columnsStorageKey(projectId: string): string {
  return `traceroot:traces:columns:v${STORAGE_VERSION}:${projectId}`;
}

function asStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string");
}

// The one gate every read and mutator passes through. Deduping belongs here, not at the
// writes: a duplicate can arrive from another tab or a hand-edited entry, bypassing mutators.
export function normalizeColumns(stored: unknown): FixedColumnId[] {
  if (typeof stored !== "object" || stored === null || Array.isArray(stored)) return NO_FIELDS;
  const { fields } = stored as Partial<StoredColumns>;
  return Array.from(new Set(asStringList(fields).filter(isFixedColumnId)));
}

export function toStoredColumns(fields: readonly FixedColumnId[]): StoredColumns {
  return { version: STORAGE_VERSION, fields: [...fields] };
}
