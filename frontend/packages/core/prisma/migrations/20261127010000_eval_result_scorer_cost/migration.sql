-- Per-result scorer cost and priced-call counts for an evaluation.
--
-- Derived by the same walk that derives the task's LLM metrics (worker.ingest_tasks),
-- which splits the trace into the candidate task and the scorer subtree. `cost` stays the
-- task's alone; the scorers' calls and cost land here, beside it.
--
-- `priced_llm_calls` counts the task's calls that carried a price, and the two scorer
-- counts do the same for the scorer subtree. Each is written as the real count, 0
-- included, for every result whose trace had spans. They stay NULL only for a result whose
-- trace had no spans, so NULL with `scorer_metrics_derived_at` set means "no spans found".
-- `scorer_cost` is NULL when no scorer call was priced, and otherwise the real sum, which
-- may be 0. A missing price is never stored as a free call.
--
-- `scorer_metrics_derived_at` is these columns' own backfill marker, kept apart from
-- `metrics_derived_at`. A worker without the scorer split still writes the task's metrics
-- and stamps the other two markers; it never touches this column, so any row it handles
-- (and every row that predates the migration) reads NULL here and the backfill derives it
-- again, whichever order the services deploy in. No data is rewritten.
--
-- The backfill selects on this marker in place of `metrics_derived_at`, so the partial
-- index behind that selection, `ix_eval_result_metrics_backfill`, is dropped. The
-- `metrics_derived_at` column stays: every worker still stamps it.
--
-- Additive and nullable with no DEFAULT, so this deploys ahead of the worker that fills
-- it. It rolls back by dropping the new columns and index; going back to a worker without
-- the scorer split also means recreating `ix_eval_result_metrics_backfill`, which that
-- worker's backfill selects on. Idempotent: every statement is IF EXISTS or IF NOT
-- EXISTS, so re-running it is a no-op.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

ALTER TABLE "evaluation_results" ADD COLUMN IF NOT EXISTS "priced_llm_calls" INTEGER;
ALTER TABLE "evaluation_results" ADD COLUMN IF NOT EXISTS "scorer_cost" DOUBLE PRECISION;
ALTER TABLE "evaluation_results" ADD COLUMN IF NOT EXISTS "scorer_llm_calls" INTEGER;
ALTER TABLE "evaluation_results" ADD COLUMN IF NOT EXISTS "scorer_priced_llm_calls" INTEGER;
ALTER TABLE "evaluation_results" ADD COLUMN IF NOT EXISTS "scorer_metrics_derived_at" TIMESTAMP(6) NULL;

DROP INDEX IF EXISTS "ix_eval_result_metrics_backfill";

-- Partial index (raw SQL — not expressible in the Prisma schema). The backfill selects
-- `scorer_metrics_derived_at IS NULL AND trace_id IS NOT NULL` newest first; rows leave the
-- index as they are stamped, so it empties once the historical results are derived.
CREATE INDEX IF NOT EXISTS "ix_eval_result_scorer_metrics_backfill" ON "evaluation_results" ("create_time")
    WHERE "scorer_metrics_derived_at" IS NULL AND "trace_id" IS NOT NULL;

COMMIT;
