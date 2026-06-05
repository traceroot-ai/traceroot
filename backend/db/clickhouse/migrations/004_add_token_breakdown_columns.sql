-- +goose Up
-- First-class token breakdown that issue #956 already extracts at ingest but
-- previously only used for cost. Stored as a generic map rather than fixed
-- columns: providers emit a growing set of dimensions
-- (cache_read/cache_write, cache-creation tiers, reasoning, audio, web-search…),
-- and a map absorbs new keys with zero migration while staying queryable
-- (usage_details['cache_read_tokens']) and aggregatable (sumMap(usage_details)).
-- These are a breakdown OF the gross input_tokens / a subset OF output_tokens;
-- display-only, they do not change cost. Map defaults to {} (never NULL), so
-- existing rows and non-LLM spans carry an empty map.
ALTER TABLE spans
    ADD COLUMN IF NOT EXISTS usage_details Map(LowCardinality(String), Int64);

-- +goose Down
ALTER TABLE spans
    DROP COLUMN IF EXISTS usage_details;
