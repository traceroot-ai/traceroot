-- Per-result LLM metrics for an evaluation's CANDIDATE TASK.
--
-- Derived from the trace's span tree by the same walk that already derives `cost`
-- (worker.ingest_tasks), which excludes scorer spans and their whole subtree — an
-- llm_judge's tokens belong to the judge, not to the system under test.
--
-- Additive and nullable, so this deploys ahead of the worker that populates it and rolls
-- back by dropping the columns and the index. Deliberately no DEFAULT: a task that made no
-- LLM calls must read NULL, not 0, exactly as `cost` does (the writer applies NULLIF), so
-- "nothing to report" stays distinguishable from "measured, and it was zero".
--
-- `metrics_derived_at` is the metrics' own backfill marker, kept apart from
-- `cost_derived_at`. A worker from before this change still writes `cost` and stamps
-- `cost_derived_at` during a rolling deploy; it never touches this column, so any row it
-- handles (and every row that predates the migration) reads NULL here and the backfill
-- derives its metrics later, whichever order the services deploy in. No data is rewritten.
--
-- Idempotent: every statement is IF NOT EXISTS, so re-running it is a no-op.
ALTER TABLE "evaluation_results" ADD COLUMN IF NOT EXISTS "prompt_tokens" INTEGER;
ALTER TABLE "evaluation_results" ADD COLUMN IF NOT EXISTS "completion_tokens" INTEGER;
ALTER TABLE "evaluation_results" ADD COLUMN IF NOT EXISTS "total_tokens" INTEGER;
ALTER TABLE "evaluation_results" ADD COLUMN IF NOT EXISTS "llm_calls" INTEGER;
ALTER TABLE "evaluation_results" ADD COLUMN IF NOT EXISTS "llm_duration_ms" INTEGER;
ALTER TABLE "evaluation_results" ADD COLUMN IF NOT EXISTS "metrics_derived_at" TIMESTAMP(6);

-- Partial index (raw SQL — not expressible in the Prisma schema). The backfill selects
-- `metrics_derived_at IS NULL AND trace_id IS NOT NULL` newest first; rows leave the index
-- as they are stamped, so it empties once the historical results are derived.
CREATE INDEX IF NOT EXISTS "ix_eval_result_metrics_backfill" ON "evaluation_results" ("create_time")
    WHERE "metrics_derived_at" IS NULL AND "trace_id" IS NOT NULL;
