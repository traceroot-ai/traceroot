-- Cross-language evaluation identity: a stable, project-scoped semantic key that decouples
-- the grouping identity from the display `name`. Runs sharing (project, evaluation_key)
-- group under one evaluation definition regardless of SDK language (Python + TypeScript),
-- and two evaluations may share a display name under different keys.
--
-- Additive + safe: the column is backfilled from the existing `name` BEFORE the NOT NULL
-- and the new unique index, so every existing evaluation keeps its current grouping
-- (its key becomes its name). The old name-uniqueness is then replaced by key-uniqueness.

-- 1. Add the column, nullable for the backfill window.
ALTER TABLE "evaluations" ADD COLUMN "evaluation_key" VARCHAR;

-- 2. Backfill: pre-key rows are keyed by their display name, preserving today's grouping.
UPDATE "evaluations" SET "evaluation_key" = "name" WHERE "evaluation_key" IS NULL;

-- 3. Now that every row has a value, make it required.
ALTER TABLE "evaluations" ALTER COLUMN "evaluation_key" SET NOT NULL;

-- 4. Move the identity invariant from (project, name) to (project, evaluation_key).
DROP INDEX "uq_evaluation_project_name";
CREATE UNIQUE INDEX "uq_evaluation_project_key" ON "evaluations"("project_id", "evaluation_key");
