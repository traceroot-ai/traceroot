-- +goose Up

ALTER TABLE spans ADD COLUMN IF NOT EXISTS error_type LowCardinality(String) DEFAULT '';

-- Rebuild the spans no-I/O projection to carry `error_type`.
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

-- Restore the original projection without `error_type`.
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
