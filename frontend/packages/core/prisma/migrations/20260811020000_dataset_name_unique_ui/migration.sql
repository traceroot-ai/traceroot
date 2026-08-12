-- Race-safe backstop for the UI dataset name-uniqueness guards. The application-level
-- pre-checks in the create/rename routes are check-then-write and can be raced past by
-- two concurrent requests; this partial unique index is the authoritative enforcement.
--
-- Scoped to UI-authored datasets (client_dataset_id IS NULL) and case-insensitive to match
-- the guards. SDK-authored datasets (client_dataset_id set) are intentionally EXCLUDED —
-- they converge on (project_id, client_dataset_id) and may legitimately share a display
-- name under different stable ids.
-- Name uniqueness was NOT enforced before this migration, so a project may already hold two
-- UI datasets with the same (case-insensitive) name. The bare index build below would then
-- abort the deploy with an opaque duplicate-key error. Fail loudly first, with an actionable
-- message and the offending (project, name) pairs, so an operator deduplicates before retrying.
DO $$
DECLARE
  dup record;
  msg text := '';
BEGIN
  FOR dup IN
    SELECT project_id, lower(name) AS lname, count(*) AS n
    FROM datasets
    WHERE client_dataset_id IS NULL
    GROUP BY project_id, lower(name)
    HAVING count(*) > 1
  LOOP
    msg := msg || format('  project %s → "%s" (%s copies)%s', dup.project_id, dup.lname, dup.n, chr(10));
  END LOOP;
  IF msg <> '' THEN
    RAISE EXCEPTION 'Cannot add uq_dataset_project_lower_name_ui — duplicate UI dataset names exist; deduplicate then re-run:%s%s', chr(10), msg;
  END IF;
END $$;

CREATE UNIQUE INDEX "uq_dataset_project_lower_name_ui"
  ON "datasets" (project_id, lower(name))
  WHERE client_dataset_id IS NULL;
