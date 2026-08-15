/**
 * A time-sortable version id — DERIVED from a dataset version's
 * creation time + number, not stored. Deriving means every version (including
 * ones created before this feature existed) shows a proper snowflake with no new
 * column, migration, or backfill.
 *
 * Layout: `((createMs - EPOCH) << 22) | versionNumber`. The high bits are a
 * millisecond timestamp so ids sort chronologically (a larger id is the newer
 * version); the low bits are the version number, which makes ids unique within a
 * dataset even for two versions minted in the same millisecond.
 *
 * Returned as a DECIMAL STRING, never a JS number: the value exceeds 2^53 and
 * would lose precision as a `number`. `BigInt(n)` calls (not `n` literals) so it
 * type-checks under a pre-ES2020 target while using native bigint at runtime.
 */

// Custom epoch (2024-01-01T00:00:00Z, in ms) so the timestamp bits stay small.
const EPOCH_MS = BigInt(1704067200000);
const SEQUENCE_BITS = BigInt(22);

/** Derive the snowflake for a version from its ISO create time + version number. */
export function versionSnowflake(createTimeIso: string, versionNumber: number): string {
  // Date.parse → NaN on a bad value; `|| 0` keeps BigInt() from throwing.
  const ms = BigInt(Date.parse(createTimeIso) || 0);
  const id = ((ms - EPOCH_MS) << SEQUENCE_BITS) | BigInt(versionNumber);
  return id.toString();
}
