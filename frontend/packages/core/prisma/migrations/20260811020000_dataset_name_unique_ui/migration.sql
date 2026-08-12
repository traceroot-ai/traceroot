-- Race-safe backstop for the UI dataset name-uniqueness guards. The application-level
-- pre-checks in the create/rename routes are check-then-write and can be raced past by
-- two concurrent requests; this partial unique index is the authoritative enforcement.
--
-- Scoped to UI-authored datasets (client_dataset_id IS NULL) and case-insensitive to match
-- the guards. SDK-authored datasets (client_dataset_id set) are intentionally EXCLUDED —
-- they converge on (project_id, client_dataset_id) and may legitimately share a display
-- name under different stable ids.
CREATE UNIQUE INDEX "uq_dataset_project_lower_name_ui"
  ON "datasets" (project_id, lower(name))
  WHERE client_dataset_id IS NULL;
