-- +goose Up
-- detector_findings is ReplacingMergeTree(timestamp) keyed
-- (project_id, trace_id, finding_id): a retraction is simply a newer row for
-- the same key with retracted=1, which wins the merge. Read queries filter
-- retracted = 0, so a clean re-evaluation can withdraw a stale finding
-- without DELETEs/mutations.
ALTER TABLE detector_findings ADD COLUMN IF NOT EXISTS retracted UInt8 DEFAULT 0;

-- +goose Down
ALTER TABLE detector_findings DROP COLUMN IF EXISTS retracted;
