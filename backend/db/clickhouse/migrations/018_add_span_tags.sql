-- +goose Up

-- Add `tags` to spans (#1748): the labels the SDKs send as traceroot.span.tags,
-- traceroot.trace.tags and OpenInference tag.tags, extracted at ingest into one
-- deduplicated list per span. A trace's tags are the union over its spans,
-- computed at read time, so they live here and never on the traces row, where a
-- later ReplacingMergeTree version of the trace could overwrite them.
--
-- DEFAULT [] backfills existing rows with no table rewrite: spans ingested before
-- this migration read as untagged (their tags were dropped at ingest and are not
-- recoverable). The column stays outside every sort and partition key, so the
-- ADD COLUMN is metadata-only. LowCardinality on the element type keeps a column of
-- a few repeated labels cheap.
--
-- 017 is skipped on purpose: an open change (#2734) claims it, and two files with
-- one goose version fail every migration.
--
-- The no-I/O projection (spans_no_io_by_start_time) is not rebuilt. A Tags filter
-- therefore reads the base table, the same accepted tradeoff 009 documents for
-- metadata_map; rebuilding the projection like 008/013 is a follow-up once the
-- filter's cost is measured.

ALTER TABLE spans ADD COLUMN IF NOT EXISTS tags Array(LowCardinality(String)) DEFAULT [];

-- +goose Down

ALTER TABLE spans DROP COLUMN IF EXISTS tags;
