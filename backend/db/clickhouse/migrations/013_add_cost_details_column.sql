-- +goose Up
-- Per-category cost breakdown, computed once at ingest alongside `cost` (same
-- prices/buckets pair — see cost_breakdown_from_buckets in
-- worker/tokens/pricing.py). Stored so the read path stops recomputing it
-- live against the current price catalogue, which is what let it disagree
-- with the stored `cost` whenever the catalogue changed after ingest (#2176).
-- Map defaults to {} (never NULL), so existing rows carry an empty
-- breakdown — their popup is suppressed, their stored `cost` still stands.
-- No backfill (out of scope per the issue).
ALTER TABLE spans
    ADD COLUMN IF NOT EXISTS cost_details Map(LowCardinality(String), Float64);

-- +goose Down
ALTER TABLE spans
    DROP COLUMN IF EXISTS cost_details;
