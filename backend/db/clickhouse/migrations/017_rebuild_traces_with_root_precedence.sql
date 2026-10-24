-- +goose Up
-- Trace rows are replacement records.  The old table used the write timestamp
-- as its version, so a late child/remote-entry row could replace a true root and
-- the result depended on ClickHouse part merge order.  Rebuild with the logical
-- trace identity first in the key and a deterministic root version.
--
-- Existing rows cannot be classified safely: before remote-parent identity was
-- persisted, a parentless row could be either a local root or a normalized
-- remote entry.  Rows that exactly match a persisted parentless span receive
-- an intermediate legacy version, but keep `root_kind = placeholder`: this
-- protects an already-established identity from a new remote entry without
-- claiming that the historical row was definitely a local root.  Other rows
-- remain placeholders and may be upgraded by a newly classified batch.
--
-- SAFETY: ClickHouse does not provide a transaction spanning the backfill and
-- table rename, so rows written between the backfill read and the RENAME would
-- be stranded in traces_old. The pause is enforced by the deployment ordering,
-- not by this file: docker-compose.prod.yml gates `rest`, `worker`, `detector`
-- and `agent` behind `migrate-clickhouse` completing successfully
-- (`service_completed_successfully`), so a stack (re)start cannot run a writer
-- against the old table after the swap. Running this migration against an
-- ALREADY-RUNNING stack (e.g. `docker compose run --rm migrate-clickhouse up`,
-- which is what CI does on an empty database) requires stopping those services
-- first (`docker compose stop rest worker detector agent`) and starting them
-- again only after goose records the migration. The async S3 queue remains the
-- source of truth while ingestion is paused, so queued batches drain after the
-- restart. The old table is retained as a rollback/reconciliation backstop;
-- never delete it as part of a retry.
--
-- RETRY: this file is safe to re-run when a failure happens at or before the
-- backfill (the step that fails first in practice): traces_v2 is dropped and
-- rebuilt from the untouched `traces`. If goose is interrupted AFTER the rename
-- but before it records the version (a millisecond-scale window), a blind retry
-- would re-derive identity from the already-rebuilt table and downgrade
-- classified rows; restore the backstop first
-- (`RENAME TABLE traces TO traces_rebuild_discard, traces_old TO traces`)
-- and remove traces_rebuild_discard afterwards.
DROP TABLE IF EXISTS traces_v2;

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

-- One canonical physical row per logical trace. The old table is ordered by
-- (project_id, toDate(trace_start_time), trace_id), so two versions of one
-- trace whose start times crossed a date boundary are separate rows that BOTH
-- survive there, and unmerged ReplacingMergeTree replays can additionally sit
-- in the same bucket. The new table is ordered by (project_id, trace_id), so
-- every copied row for one trace collapses into one logical row and the merge
-- keeps an ARBITRARY one when their versions tie. Dedup here to the row the
-- old table's own public view answered from — newest ch_update_time, newest
-- start time as the tie-break — so the classification below and the surviving
-- row are deterministic regardless of part/merge order.
--
-- The legacy classification is an UNCORRELATED tuple IN over the set of
-- parentless spans, restricted element-wise to (project_id, trace_id,
-- span_start_time, name): no span of another project or trace can satisfy a
-- row's membership. Correlated subqueries (EXISTS referencing the outer row)
-- are not supported by ClickHouse 25.2 — the repository's default — and fail
-- the migration outright. The shift operators (`<<`) are likewise not part of
-- the 25.2 SQL grammar; the constants below are (1 << 60) - 1 and 4 << 61 /
-- rank from shared/trace_identity.py written out, with `bitShiftLeft` for the
-- runtime shifts.
INSERT INTO traces_v2
(
    trace_id, project_id, trace_start_time, name, source, user_id, session_id,
    git_ref, git_repo, input, output, metadata, ch_create_time, ch_update_time,
    environment, is_evaluation, root_kind, root_version
)
SELECT
    trace_id, project_id, trace_start_time, name, source, user_id, session_id,
    git_ref, git_repo, input, output, metadata, ch_create_time, ch_update_time,
    environment, is_evaluation, 'placeholder',
    if(
        (project_id, trace_id, trace_start_time, name) IN (
            SELECT project_id, trace_id, span_start_time, name
            FROM spans
            WHERE isNull(parent_span_id)
        ),
        -- legacy_trace_version(trace_start_time, is_evaluation): the
        -- intermediate rank 4 << 61 plus the inverted millisecond start time,
        -- with the monotonic evaluation bit in bit 0. Legacy rows keep
        -- root_kind = 'placeholder' and never receive the definite-root rank.
        bitOr(
            bitOr(
                bitShiftLeft(toUInt64(4), 61),
                bitShiftLeft(
                    toUInt64(
                        toInt64(1152921504606846975) - greatest(
                            0,
                            least(
                                toInt64(toUnixTimestamp64Milli(trace_start_time)),
                                toInt64(1152921504606846975)
                            )
                        )
                    ),
                    1
                )
            ),
            toUInt64(is_evaluation)
        ),
        toUInt64(0)
    )
FROM
(
    SELECT
        trace_id, project_id, trace_start_time, name, source, user_id, session_id,
        git_ref, git_repo, input, output, metadata, ch_create_time, ch_update_time,
        environment, is_evaluation
    FROM traces AS old_traces
    ORDER BY ch_update_time DESC, trace_start_time DESC
    LIMIT 1 BY project_id, trace_id
);

ALTER TABLE traces_v2 MATERIALIZE PROJECTION traces_by_start_time;

RENAME TABLE traces TO traces_old, traces_v2 TO traces;

-- Keep the pre-migration table as a backstop, following the established spans
-- rebuild convention. A later cleanup can drop it after row parity is checked.

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
-- The old table is kept as a backstop by Up. Pause ingestion before rollback
-- (the same writer services Up's safety note names — compose enforces the
-- pause for stack restarts; stop them manually for a live stack), merge rows
-- written to the new table after the swap, and only then restore the old
-- schema; otherwise rollback would silently discard those writes. The copied
-- rows re-enter the old (project_id, toDate(trace_start_time), trace_id) key:
-- versions sharing a bucket with a pre-migration row replace it on merge
-- (their ch_update_time is newer), versions in another bucket survive as the
-- old table always allowed.
DROP VIEW IF EXISTS traces_public_v1;
INSERT INTO traces_old
(
    trace_id, project_id, trace_start_time, name, source, user_id, session_id,
    git_ref, git_repo, input, output, metadata, ch_create_time, ch_update_time,
    environment, is_evaluation
)
SELECT
    trace_id, project_id, trace_start_time, name, source, user_id, session_id,
    git_ref, git_repo, input, output, metadata, ch_create_time, ch_update_time,
    environment, is_evaluation
FROM traces;

DROP TABLE traces;
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
