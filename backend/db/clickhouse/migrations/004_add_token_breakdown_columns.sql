-- +goose Up
-- First-class columns for the token breakdown that issue #956 already extracts
-- at ingest but previously only used for cost. cache_read/cache_write are a
-- breakdown OF the gross input_tokens; reasoning_tokens is a subset OF
-- output_tokens. They are display-only and do not change cost. Nullable so
-- existing rows (and non-LLM spans) stay NULL rather than a misleading 0.
ALTER TABLE spans
    ADD COLUMN IF NOT EXISTS cache_read_tokens Nullable(Int64),
    ADD COLUMN IF NOT EXISTS cache_write_tokens Nullable(Int64),
    ADD COLUMN IF NOT EXISTS reasoning_tokens Nullable(Int64);

-- +goose Down
ALTER TABLE spans
    DROP COLUMN IF EXISTS reasoning_tokens,
    DROP COLUMN IF EXISTS cache_write_tokens,
    DROP COLUMN IF EXISTS cache_read_tokens;
