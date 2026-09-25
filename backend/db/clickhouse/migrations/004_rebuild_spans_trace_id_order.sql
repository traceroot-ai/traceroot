-- +goose Up

-- Clean up any leftover from a previous failed attempt.
-- If a prior run failed between RENAME and DROP, spans_old may still exist.
DROP TABLE IF EXISTS spans_v2;
DROP TABLE IF EXISTS spans_old;

-- Step 1: Create the replacement table with trace_id early in the sort key.
-- This makes WHERE project_id = ? AND trace_id = ? an index seek instead of
-- a full-partition scan. The projection excludes I/O blobs for time-ranged
-- list queries that never need them.
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
    environment         Nullable(String),
    ch_create_time      DateTime64(3) DEFAULT now64(3),
    ch_update_time      DateTime64(3) DEFAULT now64(3),

    PROJECTION spans_no_io_by_start_time
    (
        SELECT
            span_id, trace_id, parent_span_id, project_id,
            span_start_time, span_end_time, name, span_kind,
            status, status_message, model_name, cost,
            input_tokens, output_tokens, total_tokens,
            git_source_file, git_source_line, git_source_function,
            environment, ch_create_time, ch_update_time
        ORDER BY (project_id, span_start_time, trace_id, span_id)
    )
)
ENGINE = ReplacingMergeTree(ch_update_time)
PARTITION BY toYYYYMM(span_start_time)
ORDER BY (project_id, trace_id, span_start_time, span_id);

-- Step 2: Backfill all existing data.
INSERT INTO spans_v2 SELECT * FROM spans;

-- Step 3: Materialize the projection on existing data so it is available
-- immediately rather than waiting for background merges.
ALTER TABLE spans_v2 MATERIALIZE PROJECTION spans_no_io_by_start_time;

-- Step 4: Swap tables. The RENAME is not fully atomic for multi-table
-- renames, so a brief write gap is possible.
RENAME TABLE spans TO spans_old, spans_v2 TO spans;

-- Step 5: Catch up any rows written to the old table between the backfill
-- snapshot and the swap. We re-insert ALL rows rather than using a fixed
-- time window because the backfill duration is unpredictable on large
-- tables. ReplacingMergeTree(ch_update_time) deduplicates on the sort key
-- during background merges, so duplicates are harmless — the row with the
-- latest ch_update_time always wins.
INSERT INTO spans
SELECT * FROM spans_old;

-- Step 6: Safe to drop now that all data has been carried over.
DROP TABLE IF EXISTS spans_old;

-- +goose Down

-- Clean up any leftover from a previous failed attempt.
DROP TABLE IF EXISTS spans_v2;
DROP TABLE IF EXISTS spans_old;

-- Recreate the original table with the old sort key.
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
    environment         Nullable(String),
    ch_create_time      DateTime64(3) DEFAULT now64(3),
    ch_update_time      DateTime64(3) DEFAULT now64(3)
)
ENGINE = ReplacingMergeTree(ch_update_time)
PARTITION BY toYYYYMM(span_start_time)
ORDER BY (project_id, span_kind, toDate(span_start_time), span_id);

INSERT INTO spans_v2 SELECT * FROM spans;
RENAME TABLE spans TO spans_old, spans_v2 TO spans;

INSERT INTO spans
SELECT * FROM spans_old;

DROP TABLE IF EXISTS spans_old;
