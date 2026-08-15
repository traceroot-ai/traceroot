-- Replace the DatasetVersion primary key VALUE (a random cuid) with a time-sortable
-- snowflake: id = ((createMs - 1704067200000) << 22) | version_number, as a decimal
-- string (see frontend/ui/src/lib/eval/snowflake.ts — new versions mint the identical
-- value at creation). The wire/SDK treat the version id as an opaque string, so this is
-- a value change only — no column type or contract change.
--
-- test_cases.dataset_version_id and evaluation_runs.dataset_version_id are FKs declared
-- ON UPDATE CASCADE, so rewriting dataset_versions.id propagates to them automatically.
-- datasets.current_version_id is a plain string column (no FK constraint), so it is
-- rewritten explicitly BEFORE the parent id changes (its join keys off the old id).

-- Fail loud if two existing versions would collapse onto the same snowflake (only
-- possible across datasets minting the same version_number in the same millisecond).
-- The app nudges the ms on live creates; historical data can't, so abort with the
-- offending ids rather than silently violating the primary key.
DO $$
DECLARE
  dup record;
  msg text := '';
BEGIN
  FOR dup IN
    SELECT
      ((((extract(epoch from create_time) * 1000)::bigint - 1704067200000) << 22) | version_number) AS sid,
      count(*) AS n
    FROM dataset_versions
    GROUP BY 1
    HAVING count(*) > 1
  LOOP
    msg := msg || format('  snowflake %s (%s versions)%s', dup.sid, dup.n, chr(10));
  END LOOP;
  IF msg <> '' THEN
    RAISE EXCEPTION 'Cannot migrate dataset_versions to snowflake ids — id collisions exist; nudge create_time then re-run:%s%s', chr(10), msg;
  END IF;
END $$;

-- 1) Repoint the dataset's current-version pointer (no FK cascade) while the parent
--    ids are still the old cuids the pointer currently holds.
UPDATE datasets d
SET current_version_id =
  ((((extract(epoch from dv.create_time) * 1000)::bigint - 1704067200000) << 22) | dv.version_number)::text
FROM dataset_versions dv
WHERE d.current_version_id = dv.id;

-- 2) Rewrite the primary key; ON UPDATE CASCADE carries the new value into
--    test_cases.dataset_version_id and evaluation_runs.dataset_version_id.
UPDATE dataset_versions
SET id =
  ((((extract(epoch from create_time) * 1000)::bigint - 1704067200000) << 22) | version_number)::text;
