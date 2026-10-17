-- +goose Up
-- Whether this run version reached the model and accrued inference usage.
-- The usage meter counts a run when its latest version completed OR used
-- inference: a failed run can still burn billed model calls (the provider
-- never returns submit_result, or TypeSafe bills a 200 whose answers we
-- reject), and those tokens are recorded as a kind="detector" aIMessage row.
-- Failures that happen before any model call (missing provider key, unknown
-- model, span download failure) are written with used_inference=false and
-- must not consume quota or dilute the paid overage denominator.
-- DEFAULT false backfills existing rows: a legacy failed run keeps the old
-- behaviour (not counted) because its usage cannot be reconstructed, while a
-- legacy completed run still counts by status. used_inference is outside the
-- ORDER BY sort key, so this ALTER is metadata-only.
ALTER TABLE detector_runs ADD COLUMN IF NOT EXISTS used_inference Bool DEFAULT false;

-- +goose Down
ALTER TABLE detector_runs DROP COLUMN IF EXISTS used_inference;
