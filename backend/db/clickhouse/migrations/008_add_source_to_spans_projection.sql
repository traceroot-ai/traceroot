-- +goose Up

-- Carry `source` in the spans no-I/O projection so source-filtered reads can use
-- it again.
--
-- Migration 005 built `spans_no_io_by_start_time` for exactly one query shape:
-- one project, a `span_start_time` window, none of the input/output/metadata
-- blobs. Migration 006 then added `source` as a metadata-only ALTER — cheap
-- because `source` sits outside every sort and partition key, which 006's
-- comment notes as the advantage. What it does not note: a column outside the
-- projection's SELECT list is not merely unsorted there, it is absent. A
-- ClickHouse projection can only serve a query whose every referenced column it
-- carries, so from 006 onward every read that filters `source = 'user'` — which
-- is every customer-facing span read, via `customer_traffic_only()` — was
-- refused the projection and fell back to the base table, whose sort key buries
-- `span_start_time` behind `trace_id`. The projection built to fix that time
-- pruning has been unreachable for the queries it was built for.
--
-- `source` is added to the SELECT list only, NOT to the projection's ORDER BY.
-- Carrying the column is what restores eligibility; the sort key stays
-- `(project_id, span_start_time, trace_id, span_id)` so the time-window pruning
-- the projection exists for is unchanged, and `source = 'user'` stays a
-- PREWHERE-evaluated predicate over a LowCardinality column. Keeping `source`
-- out of every ORDER BY also preserves the invariant that makes 006 replayable
-- as a metadata-only ALTER on a fresh database (asserted by
-- tests/db/test_source_migration_is_metadata_only.py).
--
-- ClickHouse cannot rename a projection and cannot alter one in place, so the
-- new column list arrives under a new name and the old projection is retired
-- afterwards. The order matters and is the reason this is not a
-- DROP-then-ADD of the same name: dropping first would leave a window, as long
-- as the rematerialization takes, in which the table has NO no-I/O projection at
-- all. That window is not harmless — the trace-list filter semi-joins
-- (`_membership_semijoin` / `_aggregate_semijoin` in rest/services/filters/
-- translate.py) scan spans with a project id and a `span_start_time` bound and
-- no `source` predicate, so they are the reads the projection serves *today*,
-- and dropping it first would regress them for the duration of the migration.
-- Adding first costs a temporary second copy of the projection's parts instead,
-- for the length of Step 2 only, and that copy is bounded by the projection's
-- own size: input/output/metadata are in neither projection, so the overlap
-- never duplicates the blob columns.
--
-- Unlike 005 this does not need ingestion paused: there is no table rebuild and
-- no rename, new parts pick up the new projection from the moment it is
-- declared, and MATERIALIZE only backfills the parts that already exist.

-- Idempotent cleanup: if a prior run died between ADD and DROP, the new
-- projection may already be declared with an unusable partial materialization.
ALTER TABLE spans DROP PROJECTION IF EXISTS spans_no_io_by_start_time_v2;

-- Step 1 — declare the replacement. Metadata-only: parts written from here on
-- carry both projections, existing parts carry neither the new one yet.
ALTER TABLE spans ADD PROJECTION spans_no_io_by_start_time_v2
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

-- Step 2 — backfill the existing parts. `mutations_sync = 2` makes this block
-- until every replica has finished, deliberately: Step 3 must not race an
-- asynchronous mutation, or the drop lands while the replacement is still
-- half-built and the table is left with no usable no-I/O projection — the exact
-- regression this ordering exists to avoid. On a single node this behaves as
-- mutations_sync = 1.
ALTER TABLE spans MATERIALIZE PROJECTION spans_no_io_by_start_time_v2
SETTINGS mutations_sync = 2;

-- Step 3 — retire the projection that is missing `source`. Dropped here rather
-- than left as a backstop (the way 005 keeps `spans_old`): a stale table costs
-- disk once, but a redundant projection is rewritten on every insert and every
-- merge for as long as it exists.
ALTER TABLE spans DROP PROJECTION IF EXISTS spans_no_io_by_start_time;

-- +goose Down

-- Reverse: restore the projection without `source`, same ordering discipline.
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

ALTER TABLE spans MATERIALIZE PROJECTION spans_no_io_by_start_time
SETTINGS mutations_sync = 2;

ALTER TABLE spans DROP PROJECTION IF EXISTS spans_no_io_by_start_time_v2;
