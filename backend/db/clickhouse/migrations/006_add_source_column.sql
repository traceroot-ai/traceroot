-- +goose Up
-- Distinguishes detector self-traces from customer traffic. DEFAULT 'user'
-- backfills existing rows with no table rewrite: source is outside both the
-- ORDER BY sort key and the PARTITION key on spans and traces (and outside
-- the spans projection's ORDER BY), so this ADD COLUMN is metadata-only.
-- LowCardinality keeps the low-distinct-value column cheap.
ALTER TABLE spans  ADD COLUMN IF NOT EXISTS source LowCardinality(String) DEFAULT 'user';
ALTER TABLE traces ADD COLUMN IF NOT EXISTS source LowCardinality(String) DEFAULT 'user';

-- +goose Down
ALTER TABLE spans  DROP COLUMN IF EXISTS source;
ALTER TABLE traces DROP COLUMN IF EXISTS source;
