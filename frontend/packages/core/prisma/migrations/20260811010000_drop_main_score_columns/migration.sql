-- Metric-first: a run has no single headline "main score" and no run-level pass/fail.
-- Drop the now-unused main-score columns everywhere they were denormalized.
ALTER TABLE "evaluations" DROP COLUMN IF EXISTS "main_score_name";
ALTER TABLE "evaluation_runs" DROP COLUMN IF EXISTS "main_score";
ALTER TABLE "evaluation_runs" DROP COLUMN IF EXISTS "main_score_name";
ALTER TABLE "evaluation_results" DROP COLUMN IF EXISTS "main_score";
