-- +goose Up
-- Curated, project-scoped, read-only views for the public SQL gateway.
--
-- These are PARAMETERIZED views: callers supply project_id as a view-call
-- argument, e.g. spans_public_v1(project_id = {scope_project_id:String}). The
-- application MUST bind the *authenticated* project_id — DB grants do not enforce
-- which project_id is supplied (verified by the Issue 0 spike).
--
-- SQL SECURITY DEFINER: the view body reads the physical tables under the view
-- DEFINER's privileges, so the read-only gateway user can be granted SELECT on
-- these views ONLY (never on the physical spans/traces tables). No explicit
-- DEFINER is set here, so ClickHouse defaults the definer to the user that runs
-- this migration. For the hardened cloud model, run this migration (or create
-- these views) AS the dedicated scoped writer user that holds SELECT on the
-- physical tables only — NOT a superuser. See the operational runbook:
-- backend/db/clickhouse/SQL_GATEWAY_RUNBOOK.md
--
-- Dedup: spans/traces are ReplacingMergeTree(ch_update_time); the project filter
-- runs first, then `ORDER BY ch_update_time DESC LIMIT 1 BY <id>` keeps the latest
-- version of each row. Curated projection excludes project_id, ch_create_time,
-- ch_update_time, and the input/output/metadata blobs.

CREATE VIEW IF NOT EXISTS spans_public_v1
    SQL SECURITY DEFINER AS
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
    git_source_file,
    git_source_line,
    git_source_function
FROM
(
    SELECT *
    FROM spans
    WHERE project_id = {project_id:String}
    ORDER BY ch_update_time DESC
    LIMIT 1 BY span_id
);

CREATE VIEW IF NOT EXISTS traces_public_v1
    SQL SECURITY DEFINER AS
SELECT
    trace_id,
    trace_start_time,
    name,
    user_id,
    session_id,
    git_ref,
    git_repo,
    environment
FROM
(
    SELECT *
    FROM traces
    WHERE project_id = {project_id:String}
    ORDER BY ch_update_time DESC
    LIMIT 1 BY trace_id
);

-- +goose Down
DROP VIEW IF EXISTS spans_public_v1;
DROP VIEW IF EXISTS traces_public_v1;
