-- The scorers route filters scores by project and orders by create_time desc; without a
-- supporting index that is a filter-then-sort over the project's whole score history, so
-- latency grows with accumulated volume. Replace the project-only index with a composite
-- (project_id, create_time desc) — its leading column still serves plain project_id
-- lookups, so the single-column index is redundant. Mirrors evaluation_runs' index.
DROP INDEX IF EXISTS "ix_score_project_id";
CREATE INDEX "ix_score_project_create_time" ON "scores" ("project_id", "create_time" DESC);
