-- AlterTable: typed execution provenance (git/CI/SDK identity + declared candidate
-- model/prompt). Additive and nullable — existing runs are unaffected; the SDK
-- reports what it can observe and unknown fields stay absent.
ALTER TABLE "evaluation_runs" ADD COLUMN "provenance" JSONB;

-- Drop the orphan `model` column: it had no contract field and no writer, so it was
-- always NULL. Declared candidate model now lives in `provenance.declared_model`,
-- kept distinct from the (unverified) user-facing `candidate_version` label.
ALTER TABLE "evaluation_runs" DROP COLUMN "model";
