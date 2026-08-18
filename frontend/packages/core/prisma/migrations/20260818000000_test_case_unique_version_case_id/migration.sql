-- A stable test-case id must be unique within a dataset version. Content-addressed ids
-- are assigned by first-free-slot, so a regression that re-mints a live id must fail at
-- write time rather than silently inserting a duplicate row (which would corrupt
-- upsert-by-id, run comparison alignment, and the deterministic case read order).

-- CreateIndex
CREATE UNIQUE INDEX "uq_test_case_version_test_case_id" ON "test_cases"("dataset_version_id", "test_case_id");
