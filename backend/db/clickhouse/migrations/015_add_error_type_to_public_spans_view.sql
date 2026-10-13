-- +goose Up

-- Expose `error_type` (added to spans by 013) through the public SQL gateway, so
-- the SQL vocabulary matches the trace-list filter and the widget builder.
--
-- The spans view is replaced whole: a view has no ADD COLUMN, and 012 names its
-- columns explicitly, so a new curated column means restating the body. Everything
-- except the one column is 012's definition unchanged, and the reasoning for that
-- shape (dedup before the row filters, the clamped time bounds, the evaluation
-- exclusion) lives in 012's header. The traces view is not touched.
--
-- The replacement MUST restate the definer clause. Without it the view runs with
-- the caller's privileges, and the read-only gateway account holds no grant on the
-- physical tables, so every gateway query would fail.
--
-- The column is projected as is, so the view surfaces LowCardinality(String), the
-- physical type. It is appended after the existing columns rather than placed
-- beside `status_message`: `SELECT *` expands in this order, and inserting it
-- mid-list would shift every later column for a caller reading by position.
--
-- The inner SELECT reads `metadata_map`, which the no-I/O projection does not
-- carry, so a gateway query grouping by error_type reads the base table. That is
-- the existing behaviour of this view for every column, not something added here.
--
-- DROP + CREATE, not CREATE OR REPLACE: replacing an existing view swaps its
-- metadata file with renameat2(RENAME_EXCHANGE), which EFS/NFS does not support
-- ("System call renameat2() is not supported"), and the deployed ClickHouse keeps
-- its data on EFS. The view is absent between the two statements; both are safe
-- to re-run, so a failed CREATE is recovered by running the migration again.

DROP VIEW IF EXISTS spans_public_v1;

CREATE VIEW spans_public_v1
    DEFINER = sql_gateway_writer SQL SECURITY DEFINER AS
SELECT
    span_id,
    trace_id,
    parent_span_id,
    span_start_time,
    span_end_time,
    dateDiff('millisecond', span_start_time, span_end_time) AS duration_ms,
    name,
    span_kind,
    status,
    status_message,
    model_name,
    cost,
    input_tokens,
    output_tokens,
    total_tokens,
    environment,
    metadata_map AS metadata,
    git_source_file,
    git_source_line,
    git_source_function,
    error_type
FROM
(
    SELECT
        span_id, trace_id, parent_span_id, span_start_time, span_end_time, name,
        span_kind, status, status_message, model_name, cost, input_tokens,
        output_tokens, total_tokens, environment, metadata_map,
        git_source_file, git_source_line, git_source_function, error_type, source
    FROM spans
    WHERE project_id = {project_id:String}
      AND span_start_time >= greatest({start_time:DateTime64(3)}, toDateTime64('1970-01-01 00:00:00.000', 3))
      AND span_start_time <= least({end_time:DateTime64(3)} - toIntervalMillisecond(1), toDateTime64('2149-06-06 23:59:59.999', 3))
    ORDER BY ch_update_time DESC
    LIMIT 1 BY trace_id, span_id
)
WHERE source = 'user'
  AND trace_id NOT IN (
      SELECT trace_id FROM traces WHERE project_id = {project_id:String} AND is_evaluation = 1
      UNION DISTINCT
      SELECT trace_id FROM spans  WHERE project_id = {project_id:String} AND is_evaluation = 1
  );

-- +goose Down

-- Restore the 012 spans view (no error_type), definer clause included. DROP +
-- CREATE for the same EFS reason as Up.
DROP VIEW IF EXISTS spans_public_v1;

CREATE VIEW spans_public_v1
    DEFINER = sql_gateway_writer SQL SECURITY DEFINER AS
SELECT
    span_id,
    trace_id,
    parent_span_id,
    span_start_time,
    span_end_time,
    dateDiff('millisecond', span_start_time, span_end_time) AS duration_ms,
    name,
    span_kind,
    status,
    status_message,
    model_name,
    cost,
    input_tokens,
    output_tokens,
    total_tokens,
    environment,
    metadata_map AS metadata,
    git_source_file,
    git_source_line,
    git_source_function
FROM
(
    SELECT
        span_id, trace_id, parent_span_id, span_start_time, span_end_time, name,
        span_kind, status, status_message, model_name, cost, input_tokens,
        output_tokens, total_tokens, environment, metadata_map,
        git_source_file, git_source_line, git_source_function, source
    FROM spans
    WHERE project_id = {project_id:String}
      AND span_start_time >= greatest({start_time:DateTime64(3)}, toDateTime64('1970-01-01 00:00:00.000', 3))
      AND span_start_time <= least({end_time:DateTime64(3)} - toIntervalMillisecond(1), toDateTime64('2149-06-06 23:59:59.999', 3))
    ORDER BY ch_update_time DESC
    LIMIT 1 BY trace_id, span_id
)
WHERE source = 'user'
  AND trace_id NOT IN (
      SELECT trace_id FROM traces WHERE project_id = {project_id:String} AND is_evaluation = 1
      UNION DISTINCT
      SELECT trace_id FROM spans  WHERE project_id = {project_id:String} AND is_evaluation = 1
  );
