-- +goose Up
-- Carries the exception type (from the span's OTel `exception` event) for
-- issue #2378: a dashboard widget can break errors down by type, instead of
-- only showing the error rate via `status`.
--
-- DEFAULT '' backfills existing rows with no table rewrite: error_type is
-- outside both the ORDER BY sort key and the PARTITION key on spans (and
-- outside the spans projection's ORDER BY), so this ADD COLUMN is
-- metadata-only. Plain String matches the spans table convention (status is
-- String, not LowCardinality) and the SQL Gateway contract, which declares
-- error_type as String.
ALTER TABLE spans ADD COLUMN IF NOT EXISTS error_type String DEFAULT '';

-- Rebuild the no-I/O projection in place to carry `error_type`, mirroring
-- 008's treatment of `source`: a projection can only serve a query whose
-- referenced columns it ALL carries, so without this the error-type
-- breakdown would silently fall back to the base table. `error_type` stays
-- OUT of the projection's ORDER BY for the same reason `source` does.
-- In-place projection swap (DROP + ADD) — no table rewrite, no MATERIALIZE;
-- new parts get the projection on insert and existing parts pick it up as
-- they merge, exactly as in 008.
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

-- Expose `error_type` through the SQL Gateway's curated spans view. The view
-- names every column explicitly (no SELECT *), so the new column must be
-- added to both the outer projection and the inner SELECT, mirroring how
-- `status`/`status_message` are carried. Kept out of WHERE/ORDER BY: it is a
-- plain analytical column like `status_message`.
CREATE OR REPLACE VIEW spans_public_v1
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
    error_type,
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
        span_kind, status, status_message, error_type, model_name, cost, input_tokens,
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

-- +goose Down
-- Restore the pre-#2378 projection (with `source`, per 008) and drop the column.
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

-- Restore the pre-#2378 spans_public_v1 view definition (byte-identical to
-- 012): `error_type` removed from both the outer projection and inner SELECT.
CREATE OR REPLACE VIEW spans_public_v1
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
