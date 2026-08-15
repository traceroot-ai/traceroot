-- AlterTable: structured run provenance (model, prompt, config, git repo/ref/commit).
-- Additive and nullable — existing runs are unaffected; the current SDK does not send it.
ALTER TABLE "evaluation_runs" ADD COLUMN "metadata" JSONB;
