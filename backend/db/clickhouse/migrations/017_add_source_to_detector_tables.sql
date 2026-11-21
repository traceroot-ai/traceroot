-- +goose Up
-- Who wrote the row: a detector ('detector') or a Loop ('loop'). A Loop's
-- findings are written as hits of its hidden detector so the signals round
-- groups them, and every reader of detector findings, detector runs and
-- detector usage keeps only source = 'detector'. DEFAULT 'detector' backfills
-- existing rows, which are all detectors' (no Loop wrote before this column).
-- source is outside both tables' ORDER BY sort key, so this ALTER is
-- metadata-only. LowCardinality keeps the two-value column cheap.
ALTER TABLE detector_runs     ADD COLUMN IF NOT EXISTS source LowCardinality(String) DEFAULT 'detector';
ALTER TABLE detector_findings ADD COLUMN IF NOT EXISTS source LowCardinality(String) DEFAULT 'detector';

-- +goose Down
ALTER TABLE detector_runs     DROP COLUMN IF EXISTS source;
ALTER TABLE detector_findings DROP COLUMN IF EXISTS source;
