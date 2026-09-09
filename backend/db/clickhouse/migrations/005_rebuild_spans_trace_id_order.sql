-- +goose Up

-- Rebuild `spans` so single-trace lookups are an index seek instead of a
-- full-partition scan.
--
-- The original sort key `(project_id, span_kind, toDate(span_start_time),
-- span_id)` does NOT contain trace_id, so `WHERE project_id = ? AND
-- trace_id = ?` (every trace-detail and detector query) must scan the whole
-- month partition for the project and read all columns through ReplacingMerge-
-- Tree `FINAL`. With trace_id early in the key the engine reads one contiguous
-- range, and `FINAL` only merges within that one trace's rows.
--
-- ClickHouse cannot change a sort key in place, so this is the standard
-- create-new + backfill + atomic-rename rebuild, keeping the old table as a
-- backstop (same pattern other analytics backends use). The column list below
-- is the EXACT live schema (002 base + `environment` from 003 + `usage_details`
-- from 004); it is listed explicitly in every INSERT (never `SELECT *`) so a
-- future ALTER ADD COLUMN can never silently mis-map or drop a column the way a
-- positional copy would.
--
-- Safety: the multi-table RENAME is atomic on a single node, and there is
-- deliberately NO concurrent-write catch-up step — this migration must run with
-- ingestion paused (see Step 5). ReplacingMergeTree(ch_update_time) keeps the
-- newest row per sort key (so a manual reconciliation from the spans_old
-- backstop, if ever needed, is idempotent); `ch_update_time` is set to insert
-- time by the ingest path, never backdated.

-- Idempotent cleanup: if a prior run died between RENAME and DROP, these may
-- still exist. Safe because a successful run leaves neither table behind.
DROP TABLE IF EXISTS spans_v2;
DROP TABLE IF EXISTS spans_old;

-- Step 1 — replacement table: trace_id early in the sort key, plus a no-I/O
-- projection (every column except the input/output/metadata blobs) ordered by
-- time, for list/skeleton queries that never read blob columns.
CREATE TABLE spans_v2
(
    span_id             String,
    trace_id            String,
    parent_span_id      Nullable(String),
    project_id          String,
    span_start_time     DateTime64(3),
    span_end_time       Nullable(DateTime64(3)),
    name                String,
    span_kind           String,
    status              String DEFAULT 'OK',
    status_message      Nullable(String),
    model_name          Nullable(String),
    cost                Nullable(Decimal64(9)),
    input_tokens        Nullable(Int64),
    output_tokens       Nullable(Int64),
    total_tokens        Nullable(Int64),
    input               Nullable(String) CODEC(ZSTD(3)),
    output              Nullable(String) CODEC(ZSTD(3)),
    metadata            Nullable(String) CODEC(ZSTD(3)),
    git_source_file     Nullable(String),
    git_source_line     Nullable(Int32),
    git_source_function Nullable(String),
    ch_create_time      DateTime64(3) DEFAULT now64(3),
    ch_update_time      DateTime64(3) DEFAULT now64(3),
    environment         Nullable(String),
    usage_details       Map(LowCardinality(String), Int64),

    PROJECTION spans_no_io_by_start_time
    (
        SELECT
            span_id, trace_id, parent_span_id, project_id,
            span_start_time, span_end_time, name, span_kind,
            status, status_message, model_name, cost,
            input_tokens, output_tokens, total_tokens,
            git_source_file, git_source_line, git_source_function,
            ch_create_time, ch_update_time, environment, usage_details
        ORDER BY (project_id, span_start_time, trace_id, span_id)
    )
)
ENGINE = ReplacingMergeTree(ch_update_time)
PARTITION BY toYYYYMM(span_start_time)
ORDER BY (project_id, trace_id, span_start_time, span_id)
-- A projection on a ReplacingMergeTree is rejected by default (CH >= 24.x,
-- error 344) because a naive projection would not reflect rows the engine
-- collapses on merge. 'rebuild' regenerates the projection per merged part so
-- it stays consistent with the deduplicated base data and remains usable by
-- list queries over historical (already-merged) parts. We keep
-- ReplacingMergeTree (rather than a plain MergeTree that would not need this
-- setting) because live-trace updates re-write spans and we rely on
-- ch_update_time dedup.
SETTINGS deduplicate_merge_projection_mode = 'rebuild';

-- Step 2 — backfill all existing rows (explicit column list, never SELECT *).
INSERT INTO spans_v2
(
    span_id, trace_id, parent_span_id, project_id, span_start_time,
    span_end_time, name, span_kind, status, status_message, model_name, cost,
    input_tokens, output_tokens, total_tokens, input, output, metadata,
    git_source_file, git_source_line, git_source_function, ch_create_time,
    ch_update_time, environment, usage_details
)
SELECT
    span_id, trace_id, parent_span_id, project_id, span_start_time,
    span_end_time, name, span_kind, status, status_message, model_name, cost,
    input_tokens, output_tokens, total_tokens, input, output, metadata,
    git_source_file, git_source_line, git_source_function, ch_create_time,
    ch_update_time, environment, usage_details
FROM spans;

-- Step 3 — materialize the projection on the backfilled data so it is usable
-- immediately rather than only after background merges.
ALTER TABLE spans_v2 MATERIALIZE PROJECTION spans_no_io_by_start_time;

-- Step 4 — atomic swap (single statement; atomic on a single node).
RENAME TABLE spans TO spans_old, spans_v2 TO spans;

-- Step 5 — KEEP spans_old as a backstop; it is intentionally NOT dropped here.
-- A renamed-aside copy of the exact pre-migration data lets the new layout be
-- verified before anything is discarded. After confirming row parity in the
-- target environment, drop it explicitly (manually or in a follow-up migration):
--   DROP TABLE IF EXISTS spans_old;
--
-- REQUIRED PROCEDURE — there is deliberately NO concurrent-write catch-up step.
-- This migration assumes spans is not being written during the rebuild, so run
-- it with ingestion paused (scale traceroot-worker and traceroot-detector to 0)
-- for the backfill+swap window, then resume. Ingestion is async (SDK -> S3 ->
-- worker -> ClickHouse), so a pause only delays ClickHouse writes; nothing is
-- lost and the queued events flush on resume. spans_old remains as the backstop
-- for any row that was nonetheless written mid-rebuild.

-- +goose Down

-- Reverse: rebuild the table with the original sort key and no projection.
DROP TABLE IF EXISTS spans_v2;
DROP TABLE IF EXISTS spans_old;

CREATE TABLE spans_v2
(
    span_id             String,
    trace_id            String,
    parent_span_id      Nullable(String),
    project_id          String,
    span_start_time     DateTime64(3),
    span_end_time       Nullable(DateTime64(3)),
    name                String,
    span_kind           String,
    status              String DEFAULT 'OK',
    status_message      Nullable(String),
    model_name          Nullable(String),
    cost                Nullable(Decimal64(9)),
    input_tokens        Nullable(Int64),
    output_tokens       Nullable(Int64),
    total_tokens        Nullable(Int64),
    input               Nullable(String) CODEC(ZSTD(3)),
    output              Nullable(String) CODEC(ZSTD(3)),
    metadata            Nullable(String) CODEC(ZSTD(3)),
    git_source_file     Nullable(String),
    git_source_line     Nullable(Int32),
    git_source_function Nullable(String),
    ch_create_time      DateTime64(3) DEFAULT now64(3),
    ch_update_time      DateTime64(3) DEFAULT now64(3),
    environment         Nullable(String),
    usage_details       Map(LowCardinality(String), Int64)
)
ENGINE = ReplacingMergeTree(ch_update_time)
PARTITION BY toYYYYMM(span_start_time)
ORDER BY (project_id, span_kind, toDate(span_start_time), span_id);

INSERT INTO spans_v2
(
    span_id, trace_id, parent_span_id, project_id, span_start_time,
    span_end_time, name, span_kind, status, status_message, model_name, cost,
    input_tokens, output_tokens, total_tokens, input, output, metadata,
    git_source_file, git_source_line, git_source_function, ch_create_time,
    ch_update_time, environment, usage_details
)
SELECT
    span_id, trace_id, parent_span_id, project_id, span_start_time,
    span_end_time, name, span_kind, status, status_message, model_name, cost,
    input_tokens, output_tokens, total_tokens, input, output, metadata,
    git_source_file, git_source_line, git_source_function, ch_create_time,
    ch_update_time, environment, usage_details
FROM spans;

RENAME TABLE spans TO spans_old, spans_v2 TO spans;

-- As in the Up section: run with ingestion paused (no concurrent-write catch-up
-- step). Keep spans_old as a backstop; drop it manually after verifying parity:
--   DROP TABLE IF EXISTS spans_old;
