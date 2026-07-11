-- +goose Up
-- Internal tree-repair bookkeeping: root→current ancestor IDs (span_ids) and ancestor
-- names for pending-span reconstruction. These are extracted from the SDK's
-- `traceroot.span.ids_path` and `traceroot.span.path` OTel attributes. Previously
-- stored only in the metadata blob, they were lost when explicit metadata was set,
-- breaking frontend enrichSpansWithPending.
--
-- Dedicated columns fix both the live-SSE delivery path AND the base-fetch skeleton
-- read (which skips metadata to save payload size, issue #1040), following the
-- existing pattern used for git_source_* fields.
--
-- These are internal bookkeeping keys, not user-facing metadata — distinct from the
-- metadata column which stores leftover attributes and user annotations.
ALTER TABLE spans
    ADD COLUMN IF NOT EXISTS ids_path Array(String) DEFAULT [],
    ADD COLUMN IF NOT EXISTS path     Array(String) DEFAULT [];

-- +goose Down
ALTER TABLE spans
    DROP COLUMN IF EXISTS ids_path;
ALTER TABLE spans
    DROP COLUMN IF EXISTS path;
