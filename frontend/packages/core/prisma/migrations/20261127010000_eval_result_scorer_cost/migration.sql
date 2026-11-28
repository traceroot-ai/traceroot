-- Per-result scorer cost and priced-call counts for an evaluation.
--
-- Derived by the same walk that derives the task's LLM metrics (worker.ingest_tasks),
-- which splits the trace into the candidate task and the scorer subtree. `cost` stays the
-- task's alone; the scorers' calls and cost land here, beside it.
--
-- `priced_llm_calls` counts the task's calls that carried a price, and the two scorer
-- counts do the same for the scorer subtree. Each is written as the real count, 0
-- included, for every result whose trace had spans. They stay NULL only for a result whose
-- trace had no spans, so NULL with `metrics_derived_at` set means "no spans found".
-- `scorer_cost` is NULL when no scorer call was priced, and otherwise the real sum, which
-- may be 0. A missing price is never stored as a free call.
--
-- No new marker: these columns ride on `metrics_derived_at` from
-- 20261127000000_eval_result_llm_metrics, so the backfill that fills those metrics fills
-- these too. That migration's worker and this one must reach production in the same
-- deploy; rows stamped by a worker without these columns would never be revisited.
--
-- Additive and nullable with no DEFAULT, so this deploys ahead of the worker that fills
-- it and rolls back by dropping the columns. Idempotent: every statement is IF NOT EXISTS.
ALTER TABLE "evaluation_results" ADD COLUMN IF NOT EXISTS "priced_llm_calls" INTEGER;
ALTER TABLE "evaluation_results" ADD COLUMN IF NOT EXISTS "scorer_cost" DOUBLE PRECISION;
ALTER TABLE "evaluation_results" ADD COLUMN IF NOT EXISTS "scorer_llm_calls" INTEGER;
ALTER TABLE "evaluation_results" ADD COLUMN IF NOT EXISTS "scorer_priced_llm_calls" INTEGER;
