-- +goose Up
-- Gates the runs-tab "open detector run trace" link. Historical runs (and any
-- run whose self-trace emission failed) stay false, so the UI renders run_id
-- as plain text for them and links only when a self-trace was actually
-- captured. DEFAULT false backfills existing rows; self_traced is outside the
-- ORDER BY sort key, so this ALTER is metadata-only.
ALTER TABLE detector_runs ADD COLUMN IF NOT EXISTS self_traced Bool DEFAULT false;

-- +goose Down
ALTER TABLE detector_runs DROP COLUMN IF EXISTS self_traced;
