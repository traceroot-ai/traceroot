-- +goose Up

-- Rebuild the spans no-I/O projection to carry `source`, so source-filtered
-- reads can use it.
--
-- The projection (spans_no_io_by_start_time, from 005) exists to serve the
-- time-ranged, no-blob span reads behind the trace list, span skeletons and
-- every dashboard widget. But `source` was added afterward (006) as a
-- metadata-only column and was never added to the projection. A projection can
-- only serve a query whose referenced columns it ALL carries, so every read
-- filtering `source = 'user'` (which is all customer reads) was silently
-- disqualified from the projection and fell back to the base table — whose sort
-- key buries span_start_time behind trace_id, exactly the weak time pruning the
-- projection was built to fix.
--
-- Adding `source` to the projection's column list makes those reads eligible
-- again: the query prunes by (project_id, span_start_time) through the
-- projection as before, and `source = 'user'` is applied as a residual filter
-- on the pruned rows. `source` is deliberately kept OUT of the projection's
-- ORDER BY — putting it in the key would prune detector rows at the index level
-- too, but it would also move `source` into a sort key, which 006 relies on it
-- never being (that is what keeps the ADD COLUMN metadata-only, and a test
-- enforces it across every migration). Eligibility is the fix that matters here:
-- it turns a full base-table scan back into a time-pruned projection read.
-- Validated on a scratch copy: a source-filtered time-window query uses the
-- rebuilt projection and prunes to a single granule.
--
-- In-place projection swap (DROP + ADD) — the base table is not rewritten and
-- there is no table rename. ADD PROJECTION on a ReplacingMergeTree needs
-- deduplicate_merge_projection_mode = 'rebuild', which the table already carries
-- from 005.
--
-- Deliberately NO `MATERIALIZE PROJECTION`. The swap is instant metadata: new
-- parts get the projection on insert, and existing parts get it as they merge.
-- Source-filtered reads over parts that don't yet carry it fall back to the base
-- table exactly as they do today, so there is no correctness window — only a
-- gradual improvement that reaches historical data as parts merge. This keeps
-- the migration cheap; `spans` is large and a one-shot MATERIALIZE over the
-- whole table is a heavy background mutation we don't want to force at deploy.
-- If historical-window reads need the projection sooner, run
-- `ALTER TABLE spans MATERIALIZE PROJECTION spans_no_io_by_start_time`
-- deliberately, off the migration path, during low traffic.

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

-- +goose Down

-- Restore the original projection: no `source`, ordered by project_id then
-- span_start_time (the 005 definition).
ALTER TABLE spans DROP PROJECTION IF EXISTS spans_no_io_by_start_time;

ALTER TABLE spans ADD PROJECTION spans_no_io_by_start_time
(
    SELECT
        span_id, trace_id, parent_span_id, project_id,
        span_start_time, span_end_time, name, span_kind,
        status, status_message, model_name, cost,
        input_tokens, output_tokens, total_tokens,
        git_source_file, git_source_line, git_source_function,
        ch_create_time, ch_update_time, environment, usage_details
    ORDER BY (project_id, span_start_time, trace_id, span_id)
);
