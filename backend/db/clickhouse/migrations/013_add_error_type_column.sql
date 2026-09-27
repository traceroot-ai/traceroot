-- +goose Up
-- Add error_type for dashboard error breakdown. It's metadata-only.
-- Default is empty string (no error type).
ALTER TABLE spans ADD COLUMN IF NOT EXISTS error_type LowCardinality(String) DEFAULT '';

-- +goose Down
ALTER TABLE spans DROP COLUMN IF EXISTS error_type;
