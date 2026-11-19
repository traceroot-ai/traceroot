-- A stable test-case id must be unique within a dataset version. Content-addressed ids
-- are assigned by first-free-slot, so a regression that re-mints a live id must fail at
-- write time rather than silently inserting a duplicate row (which would corrupt
-- upsert-by-id, run comparison alignment, and the deterministic case read order).

-- This index is built NON-concurrently on purpose. `CREATE INDEX CONCURRENTLY` cannot run
-- inside a transaction block, but Prisma Migrate (`migrate deploy`, run from the Helm
-- pre-upgrade hook) wraps every migration file in a transaction on PostgreSQL — so a
-- CONCURRENTLY build here would abort the whole migration and block the upgrade. `test_cases`
-- was introduced only one migration earlier (20260814000001_offline_eval), so it is small or
-- empty at any upgrade applying this, and the plain build's ShareLock is held only briefly.
-- The lock_timeout below is a safety bound: rather than queue behind a long-running writer
-- transaction and stall writers indefinitely, fail fast (the migrate Job retries per its
-- backoffLimit). SET LOCAL scopes the timeout to this migration's own transaction, so it
-- applies to the CREATE INDEX below but does not leak into later pending migrations that
-- `migrate deploy` runs on the same connection.
SET LOCAL lock_timeout = '5s';

-- CreateIndex
CREATE UNIQUE INDEX "uq_test_case_version_test_case_id" ON "test_cases"("dataset_version_id", "test_case_id");
