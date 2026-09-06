-- +goose Up
-- Curated, project-scoped, read-only views for the public SQL gateway.
--
-- These are PARAMETERIZED views: callers supply project_id as a view-call
-- argument, e.g. spans_public_v1(project_id = {scope_project_id:String}). The
-- application MUST bind the *authenticated* project_id — DB grants do not enforce
-- which project_id is supplied (verified against ClickHouse 24.3).
--
-- SQL SECURITY DEFINER: the view body reads the physical tables under the view
-- DEFINER's privileges, so the read-only gateway user can be granted SELECT on
-- these views ONLY (never on the physical spans/traces tables). The definer is
-- set EXPLICITLY to `sql_gateway_writer` — a dedicated, non-superuser role that
-- holds SELECT on the physical spans/traces tables only. That role MUST exist
-- before this migration runs, or the CREATE VIEW fails; this makes the security
-- dependency explicit and enforced rather than silently defaulting to whoever
-- applies the migration. An admin/deploy user may run this migration as long as
-- it has permission to create a view with this definer. The views use CREATE OR
-- REPLACE (not IF NOT EXISTS) so re-applying reliably (re)sets this definer even if
-- a view already exists from a prior version. See the runbook:
-- backend/db/clickhouse/SQL_GATEWAY_RUNBOOK.md
--
-- Dedup: spans/traces are ReplacingMergeTree(ch_update_time); the project filter
-- runs first, then `ORDER BY ch_update_time DESC LIMIT 1 BY <id>` keeps the latest
-- version of each row. Curated projection excludes project_id, ch_create_time,
-- ch_update_time, and the input/output blobs. `metadata` is the queryable one-level
-- `metadata_map`, renamed; the raw JSON document stays unexposed.
--
-- Rows are curated too, not just columns. A row the product hides on every other
-- read path must not reappear here:
--
--   * `source = 'user'` names the value that IS customer traffic, rather than
--     excluding the internal markers known today, so a marker added tomorrow is
--     excluded the day it appears.
--
--   * Evaluation traces are excluded by TRACE MEMBERSHIP, never by a per-row
--     `is_evaluation = 0`. Two reasons a per-row check leaks: ingest makes the flag
--     monotonic only within a batch, so a later batch carrying just the non-eval
--     spans rewrites the trace row to 0 with a newer ch_update_time and the deduped
--     latest row un-hides it; and ordinary child spans of an evaluation trace are
--     stored as 0 anyway. Both physical tables are consulted, because a trace can be
--     flagged on either. The sub-selects repeat the project scope: a parameterized
--     view cannot see the caller's WHERE clause, so without it they would read
--     across tenants.
--
-- These mirror rest.services.trace_reader.customer_traffic_only and
-- _evaluation_exclusion. The public schema contract in
-- backend/rest/services/sql/schema.py is the source of truth; a .sql file cannot
-- import it, so the two are kept in step by the tests in
-- tests/db/test_public_sql_views_migration.py.

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
    SELECT *
    FROM spans
    WHERE project_id = {project_id:String}
      AND source = 'user'
      AND trace_id NOT IN (
          SELECT trace_id FROM traces WHERE project_id = {project_id:String} AND is_evaluation = 1
          UNION DISTINCT
          SELECT trace_id FROM spans  WHERE project_id = {project_id:String} AND is_evaluation = 1
      )
    ORDER BY ch_update_time DESC
    LIMIT 1 BY span_id
);

CREATE OR REPLACE VIEW traces_public_v1
    DEFINER = sql_gateway_writer SQL SECURITY DEFINER AS
SELECT
    trace_id,
    trace_start_time,
    name,
    user_id,
    session_id,
    git_ref,
    git_repo,
    environment,
    metadata_map AS metadata
FROM
(
    SELECT *
    FROM traces
    WHERE project_id = {project_id:String}
      AND source = 'user'
      AND trace_id NOT IN (
          SELECT trace_id FROM traces WHERE project_id = {project_id:String} AND is_evaluation = 1
          UNION DISTINCT
          SELECT trace_id FROM spans  WHERE project_id = {project_id:String} AND is_evaluation = 1
      )
    ORDER BY ch_update_time DESC
    LIMIT 1 BY trace_id
);

-- +goose Down
DROP VIEW IF EXISTS spans_public_v1;
DROP VIEW IF EXISTS traces_public_v1;
