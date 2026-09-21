-- Per-result LLM metrics for an evaluation's CANDIDATE TASK.
--
-- Derived from the trace's span tree by the same walk that already derives `cost`
-- (worker.ingest_tasks), which excludes scorer spans and their whole subtree — an
-- llm_judge's tokens belong to the judge, not to the system under test.
--
-- Additive and nullable, so this deploys ahead of the worker that populates it and rolls
-- back by dropping five columns. Deliberately no DEFAULT: a task that made no LLM calls
-- must read NULL, not 0, exactly as `cost` does (the writer applies NULLIF), so "nothing
-- to report" stays distinguishable from "measured, and it was zero".
--
-- No new backfill marker: these are written in the same statement as `cost` and settle
-- under the existing `cost_derived_at` stamp and its partial index.
ALTER TABLE "evaluation_results" ADD COLUMN "prompt_tokens" INTEGER;
ALTER TABLE "evaluation_results" ADD COLUMN "completion_tokens" INTEGER;
ALTER TABLE "evaluation_results" ADD COLUMN "total_tokens" INTEGER;
ALTER TABLE "evaluation_results" ADD COLUMN "llm_calls" INTEGER;
ALTER TABLE "evaluation_results" ADD COLUMN "llm_duration_ms" INTEGER;
