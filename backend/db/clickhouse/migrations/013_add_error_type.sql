-- +goose Up

-- Add `error_type` to spans: the exception type extracted at ingest so
-- dashboards can break errors down by type. DEFAULT '' backfills existing
-- rows with no table rewrite; the column stays outside every sort and
-- partition key, so the ADD COLUMN is metadata-only. LowCardinality keeps
-- the low-distinct-value column cheap.
--
-- The no-I/O projection is rebuilt to carry the column, mirroring 008. A
-- projection only serves queries whose referenced columns it all carries;
-- without this, any read grouping or filtering on error_type would fall
-- back to the base table and lose time pruning. In-place DROP + ADD, no
-- MATERIALIZE: new parts get the projection on insert, existing parts only
-- when they next merge, so historical partitions need
-- `ALTER TABLE spans MATERIALIZE PROJECTION spans_no_io_by_start_time`
-- run deliberately off the migration path, as 008 describes.

ALTER TABLE spans ADD COLUMN IF NOT EXISTS error_type LowCardinality(String) DEFAULT '';

ALTER TABLE spans DROP PROJECTION IF EXISTS spans_no_io_by_start_time;

ALTER TABLE spans ADD PROJECTION spans_no_io_by_start_time
(
    SELECT
        span_id, trace_id, parent_span_id, project_id,
        span_start_time, span_end_time, name, span_kind,
        status, status_message, model_name, cost,
        input_tokens, output_tokens, total_tokens,
        git_source_file, git_source_line, git_source_function,
        ch_create_time, ch_update_time, environment, usage_details,
        source, error_type
    ORDER BY (project_id, span_start_time, trace_id, span_id)
);

-- +goose Down

-- Restore the 008 projection (no error_type), then drop the column.
ALTER TABLE spans DROP PROJECTION IF EXISTS spans_no_io_by_start_time;

ALTER TABLE spans ADD PROJECTION spans_no_io_by_start_time
(
    SELECT
        span_id, trace_id, parent_span_id, project_id,
        span_start_time, span_end_time, name, span_kind,
        status, status_message, model_name, cost,
        input_tokens, output_tokens, total_tokens,
        git_source_file, git_source_line, git_source_function,
        ch_create_time, ch_update_time, environment, usage_details,
        source
    ORDER BY (project_id, span_start_time, trace_id, span_id)
);

ALTER TABLE spans DROP COLUMN IF EXISTS error_type;
