-- `test_cases` carried a btree on `project_id` alone that no read selects. Every query
-- against the table filters by `dataset_version_id` (dataset detail, version detail,
-- publish, the per-version case counts) except one — the trace-to-case lookup, which
-- filters `(project_id, source_trace_id)` and is resolved by the far more selective
-- `ix_test_case_source_trace_id`. `project_id` also carries no foreign key on this model,
-- so no constraint check reads it either. The index only cost write throughput and storage
-- on the fastest-growing table in the schema: a dataset publish writes one row per case,
-- so its maintenance scaled with cases x versions.

-- Dropped NON-concurrently on purpose. `DROP INDEX CONCURRENTLY` cannot run inside a
-- transaction block, and Prisma Migrate (`migrate deploy`, run from the Helm pre-upgrade
-- hook) wraps every migration file in a transaction on PostgreSQL — so a CONCURRENTLY drop
-- here would abort the whole migration and block the upgrade. A plain DROP INDEX only has
-- to unlink the index and takes its ACCESS EXCLUSIVE lock on `test_cases` briefly; it does
-- not rewrite the table. The lock_timeout is a safety bound: rather than queue behind a
-- long-running reader or writer and stall the table indefinitely, fail fast (the migrate
-- Job retries per its backoffLimit). SET LOCAL scopes the timeout to this migration's own
-- transaction, so it does not leak into later pending migrations `migrate deploy` runs on
-- the same connection.
SET LOCAL lock_timeout = '5s';

-- DropIndex
DROP INDEX IF EXISTS "ix_test_case_project_id";
