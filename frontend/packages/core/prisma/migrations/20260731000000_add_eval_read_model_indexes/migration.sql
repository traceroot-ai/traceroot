-- CreateIndex: the runs list is `where project_id = ? [and evaluation_id = ?]
-- [and dataset_id = ?] order by started_at desc` with offset pagination. With only
-- the single-column project_id index, every page fetches the whole matching history
-- and top-N-sorts it, so a page costs O(project run count) instead of O(page size).
-- Descending to match the ordering exactly, turning pagination into an index scan.
CREATE INDEX "ix_evaluation_run_project_started_at" ON "evaluation_runs"("project_id", "started_at" DESC);
CREATE INDEX "ix_evaluation_run_evaluation_started_at" ON "evaluation_runs"("evaluation_id", "started_at" DESC);

-- CreateIndex: the dataset filter on the same list had no index on this table at all.
CREATE INDEX "ix_evaluation_run_dataset_started_at" ON "evaluation_runs"("dataset_id", "started_at" DESC);

-- CreateIndex: the lineage aggregate sums cost and duration grouped by evaluation_id.
CREATE INDEX "ix_evaluation_result_evaluation_id" ON "evaluation_results"("evaluation_id");
