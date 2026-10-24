-- +goose Up
-- Trace rows are replacement records.  The old table used the write timestamp
-- as its version, so a late child/remote-entry row could replace a true root and
-- the result depended on ClickHouse part merge order.  Rebuild with the logical
-- trace identity first in the key and a deterministic root version.
--
-- Existing rows cannot be classified safely: before remote-parent identity was
-- persisted, a parentless row could be either a local root or a normalized
-- remote entry.  They intentionally remain placeholders (version 0) and are
-- promoted only by a newly classified ingest batch.
DROP TABLE IF EXISTS traces_v2;
DROP TABLE IF EXISTS traces_old;

CREATE TABLE traces_v2
(
    trace_id            String,
    project_id          String,
    trace_start_time    DateTime64(3),
    name                String,
    source              LowCardinality(String) DEFAULT 'user',
    user_id             Nullable(String),
    session_id          Nullable(String),
    git_ref             Nullable(String),
    git_repo            Nullable(String),
    input               Nullable(String) CODEC(ZSTD(3)),
    output              Nullable(String) CODEC(ZSTD(3)),
    metadata            Nullable(String) CODEC(ZSTD(3)),
    metadata_map        Map(LowCardinality(String), String)
        MATERIALIZED CAST(
            arrayMap(
                kv -> (
                    tupleElement(kv, 1),
                    if(
                        startsWith(tupleElement(kv, 2), '"'),
                        JSONExtractString(tupleElement(kv, 2)),
                        tupleElement(kv, 2)
                    )
                ),
                arrayFilter(
                    kv -> NOT startsWith(tupleElement(kv, 1), 'traceroot.'),
                    JSONExtractKeysAndValuesRaw(ifNull(metadata, ''))
                )
            ),
            'Map(LowCardinality(String), String)'
        ),
    ch_create_time      DateTime64(3) DEFAULT now64(3),
    ch_update_time      DateTime64(3) DEFAULT now64(3),
    environment         Nullable(String),
    is_evaluation       UInt8 DEFAULT 0,
    root_kind           Enum8('placeholder' = 0, 'remote_parent' = 1, 'root' = 2)
                            DEFAULT 'placeholder',
    root_version        UInt64 DEFAULT 0,

    PROJECTION traces_by_start_time
    (
        SELECT
            trace_id, project_id, trace_start_time, name, source,
            user_id, session_id, git_ref, git_repo, ch_create_time,
            ch_update_time, environment, is_evaluation, root_kind, root_version,
            metadata_map
        ORDER BY (project_id, toDate(trace_start_time), trace_id)
    )
)
ENGINE = ReplacingMergeTree(root_version)
PARTITION BY toYYYYMM(trace_start_time)
ORDER BY (project_id, trace_id)
SETTINGS deduplicate_merge_projection_mode = 'rebuild';

INSERT INTO traces_v2
(
    trace_id, project_id, trace_start_time, name, source, user_id, session_id,
    git_ref, git_repo, input, output, metadata, ch_create_time, ch_update_time,
    environment, is_evaluation, root_kind, root_version
)
SELECT
    trace_id, project_id, trace_start_time, name, source, user_id, session_id,
    git_ref, git_repo, input, output, metadata, ch_create_time, ch_update_time,
    environment, is_evaluation, 'placeholder', 0
FROM traces;

ALTER TABLE traces_v2 MATERIALIZE PROJECTION traces_by_start_time;

RENAME TABLE traces TO traces_old, traces_v2 TO traces;

-- Keep the pre-migration table as a backstop, following the established spans
-- rebuild convention.  A later cleanup can drop it after row parity is checked;
-- rerunning this file drops only the previous backstop before rebuilding again.

-- Migration 012 created the public view before root_version existed.  Replacing
-- it here is required both for upgrades (where 012 is already recorded) and for
-- fresh installations (where its parameterized body is resolved after this table
-- exists).
DROP VIEW IF EXISTS traces_public_v1;

CREATE VIEW traces_public_v1
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
    SELECT
        trace_id, trace_start_time, name, user_id, session_id, git_ref, git_repo,
        environment, metadata_map, source
    FROM traces
    WHERE project_id = {project_id:String}
      AND trace_start_time >= greatest({start_time:DateTime64(3)}, toDateTime64('1970-01-01 00:00:00.000', 3))
      AND trace_start_time <= least({end_time:DateTime64(3)} - toIntervalMillisecond(1), toDateTime64('2149-06-06 23:59:59.999', 3))
    ORDER BY root_version DESC, ch_update_time DESC
    LIMIT 1 BY trace_id
)
WHERE source = 'user'
  AND trace_id NOT IN (
      SELECT trace_id FROM traces WHERE project_id = {project_id:String} AND is_evaluation = 1
      UNION DISTINCT
      SELECT trace_id FROM spans  WHERE project_id = {project_id:String} AND is_evaluation = 1
  );

-- +goose Down
-- The old table is kept as a backstop by Up, so rollback can restore the exact
-- pre-migration schema and data without guessing a root classification.
DROP VIEW IF EXISTS traces_public_v1;
DROP TABLE IF EXISTS traces;
RENAME TABLE traces_old TO traces;

CREATE VIEW traces_public_v1
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
    SELECT
        trace_id, trace_start_time, name, user_id, session_id, git_ref, git_repo,
        environment, metadata_map, source
    FROM traces
    WHERE project_id = {project_id:String}
      AND trace_start_time >= greatest({start_time:DateTime64(3)}, toDateTime64('1970-01-01 00:00:00.000', 3))
      AND trace_start_time <= least({end_time:DateTime64(3)} - toIntervalMillisecond(1), toDateTime64('2149-06-06 23:59:59.999', 3))
    ORDER BY ch_update_time DESC
    LIMIT 1 BY trace_id
)
WHERE source = 'user'
  AND trace_id NOT IN (
      SELECT trace_id FROM traces WHERE project_id = {project_id:String} AND is_evaluation = 1
      UNION DISTINCT
      SELECT trace_id FROM spans  WHERE project_id = {project_id:String} AND is_evaluation = 1
  );
