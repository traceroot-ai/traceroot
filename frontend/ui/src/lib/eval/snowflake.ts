/**
 * A time-sortable dataset-version id: `((createMs - EPOCH) << 22) | versionNumber`,
 * returned as a DECIMAL STRING. The high bits are a millisecond timestamp so ids
 * sort chronologically (a larger id is the newer version); the low 22 bits are the
 * version number, so ids are unique within a dataset even for two versions minted in
 * the same millisecond.
 *
 * This value is now GENERATED and STORED as `DatasetVersion.id` (it replaced the
 * cuid primary key). `versionSnowflakeFromMs` mints it at creation; `versionSnowflake`
 * derives it from a stored ISO time (used by the one-off backfill / tests). A decimal
 * string, never a JS number: the value exceeds 2^53 and would lose precision as a
 * `number`. `BigInt(n)` calls (not `n` literals) so it type-checks under a pre-ES2020
 * target while using native bigint at runtime.
 */

// Custom epoch (2024-01-01T00:00:00Z, in ms) so the timestamp bits stay small.
const EPOCH_MS = BigInt(1704067200000);
const SEQUENCE_BITS = BigInt(22);

/** Mint the snowflake id from a millisecond timestamp + version number. */
export function versionSnowflakeFromMs(createMs: number, versionNumber: number): string {
  const id = ((BigInt(createMs) - EPOCH_MS) << SEQUENCE_BITS) | BigInt(versionNumber);
  return id.toString();
}

/** Derive the snowflake for a version from its ISO create time + version number. */
export function versionSnowflake(createTimeIso: string, versionNumber: number): string {
  // Date.parse → NaN on a bad value; `|| 0` keeps BigInt() from throwing.
  return versionSnowflakeFromMs(Date.parse(createTimeIso) || 0, versionNumber);
}
