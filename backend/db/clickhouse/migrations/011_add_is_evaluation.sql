-- +goose Up
-- Explicit classification flag for offline-evaluation traces/spans.
--
-- This is deliberately NOT folded into `environment`. `environment` is a
-- user-namespace value (the SDK's TRACEROOT_ENVIRONMENT deployment tag: production,
-- staging, ...) and must not double as an internal control flag: a customer who
-- legitimately names their environment "evaluation" would otherwise have their real
-- traces treated as eval runs and hidden, and an eval run in a project that DOES set
-- TRACEROOT_ENVIRONMENT would go unclassified. The two concepts are orthogonal and
-- get one column each.
--
-- UInt8 rather than Nullable(UInt8): "unknown" and "not an evaluation" are the same
-- thing for every consumer, and a non-null default keeps the read-side predicate a
-- plain `is_evaluation = 0` with no NULL handling.
ALTER TABLE spans  ADD COLUMN IF NOT EXISTS is_evaluation UInt8 DEFAULT 0;
ALTER TABLE traces ADD COLUMN IF NOT EXISTS is_evaluation UInt8 DEFAULT 0;

-- +goose Down
ALTER TABLE spans  DROP COLUMN IF EXISTS is_evaluation;
ALTER TABLE traces DROP COLUMN IF EXISTS is_evaluation;
