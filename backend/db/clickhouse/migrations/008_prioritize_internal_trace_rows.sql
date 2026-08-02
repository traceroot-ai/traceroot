-- +goose Up

-- The internal detector exporter can send one trace in several concurrent
-- batches during shutdown. A root-bearing batch has the authoritative trace
-- summary; a rootless batch contains only a temporary placeholder. The old
-- ReplacingMergeTree(ch_update_time) rule could keep the placeholder merely
-- because it was inserted later.
--
-- Rebuild the table with a version that compares:
--   1. trace_authority (authoritative rows beat internal placeholders)
--   2. ch_update_time (newer rows win when authority is equal)
--
-- A temporary materialized view mirrors writes that arrive during the
-- copy-and-swap window, so active ingestion cannot strand new rows in the
-- renamed backup table.

DROP TABLE IF EXISTS traces_authority_write_mirror;
DROP TABLE IF EXISTS traces_with_authority;
DROP TABLE IF EXISTS traces_before_authority;

CREATE TABLE traces_with_authority
(
    trace_id            String,
    project_id          String,
    trace_start_time    DateTime64(3),
    name                String,
    user_id             Nullable(String),
    session_id          Nullable(String),
    git_ref             Nullable(String),
    git_repo            Nullable(String),
    input               Nullable(String) CODEC(ZSTD(3)),
    output              Nullable(String) CODEC(ZSTD(3)),
    metadata            Nullable(String) CODEC(ZSTD(3)),
    ch_create_time      DateTime64(3) DEFAULT now64(3),
    ch_update_time      DateTime64(3) DEFAULT now64(3),
    environment         Nullable(String),
    source              LowCardinality(String) DEFAULT 'user',

    -- 0 = internal batch did not contain this trace's root span.
    -- 1 = internal root-bearing row, public row, or historical row.
    trace_authority     UInt8 DEFAULT 1,

    -- The high bit stores authority; the lower bits store Unix milliseconds.
    -- Defaulting to authority 1 preserves public/legacy writer behavior during
    -- a rolling deployment if a writer omits the two new columns.
    trace_version       UInt64 DEFAULT
        bitShiftLeft(toUInt64(1), 63)
        + toUInt64(toUnixTimestamp64Milli(ch_update_time))
)
ENGINE = ReplacingMergeTree(trace_version)
PARTITION BY toYYYYMM(trace_start_time)
ORDER BY (project_id, toDate(trace_start_time), trace_id);

-- Existing REST/worker pods may keep inserting into `traces` while the
-- historical copy below runs. This temporary materialized view forwards every
-- newly inserted block into the replacement table so those rows participate in
-- the atomic table swap instead of being stranded in the backup table.
CREATE MATERIALIZED VIEW traces_authority_write_mirror
TO traces_with_authority
AS
SELECT
    trace_id,
    project_id,
    trace_start_time,
    name,
    user_id,
    session_id,
    git_ref,
    git_repo,
    input,
    output,
    metadata,
    ch_create_time,
    ch_update_time,
    environment,
    source,

    -- The currently deployed writers do not provide authority information.
    -- Preserve their previous/public behavior by treating those rows as
    -- authoritative. New application pods explicitly mark internal rootless
    -- rows after the migration finishes.
    toUInt8(1) AS trace_authority,

    -- Authority occupies the high bit. The timestamp continues deciding
    -- between two rows that have the same authority.
    bitShiftLeft(toUInt64(1), 63)
        + toUInt64(toUnixTimestamp64Milli(ch_update_time))
        AS trace_version
FROM traces;

-- Copy all rows that existed before the migration. A concurrently inserted
-- row may occasionally arrive through both this copy and the materialized
-- view. That is safe: both copies have the same ReplacingMergeTree key and
-- version and therefore collapse to one winner.
INSERT INTO traces_with_authority
(
    trace_id,
    project_id,
    trace_start_time,
    name,
    user_id,
    session_id,
    git_ref,
    git_repo,
    input,
    output,
    metadata,
    ch_create_time,
    ch_update_time,
    environment,
    source,
    trace_authority,
    trace_version
)
SELECT
    trace_id,
    project_id,
    trace_start_time,
    name,
    user_id,
    session_id,
    git_ref,
    git_repo,
    input,
    output,
    metadata,
    ch_create_time,
    ch_update_time,
    environment,
    source,

    -- Historical rows cannot be classified reliably after the fact. Treat
    -- them as authoritative so a new internal placeholder cannot replace
    -- existing data; newer authority-1 rows still win by timestamp.
    1,
    bitShiftLeft(toUInt64(1), 63)
        + toUInt64(toUnixTimestamp64Milli(ch_update_time))
FROM traces;

-- Atomic on a single ClickHouse node. Keep the previous table as a backstop
-- until row counts and winner selection have been verified after deployment.
RENAME TABLE
    traces TO traces_before_authority,
    traces_with_authority TO traces;

-- New writes now resolve `traces` directly to the replacement table, so the
-- temporary forwarding rule is no longer necessary.
DROP TABLE traces_authority_write_mirror;


-- +goose Down

-- Rebuild the pre-version schema from the current table so rows written after
-- the Up migration survive rollback.
DROP TABLE IF EXISTS traces_without_authority_write_mirror;
DROP TABLE IF EXISTS traces_without_authority;

CREATE TABLE traces_without_authority
(
    trace_id            String,
    project_id          String,
    trace_start_time    DateTime64(3),
    name                String,
    user_id             Nullable(String),
    session_id          Nullable(String),
    git_ref             Nullable(String),
    git_repo            Nullable(String),
    input               Nullable(String) CODEC(ZSTD(3)),
    output              Nullable(String) CODEC(ZSTD(3)),
    metadata            Nullable(String) CODEC(ZSTD(3)),
    ch_create_time      DateTime64(3) DEFAULT now64(3),
    ch_update_time      DateTime64(3) DEFAULT now64(3),
    environment         Nullable(String),
    source              LowCardinality(String) DEFAULT 'user'
)
ENGINE = ReplacingMergeTree(ch_update_time)
PARTITION BY toYYYYMM(trace_start_time)
ORDER BY (project_id, toDate(trace_start_time), trace_id);

-- Keep forwarding new writes while the rollback table is populated.
CREATE MATERIALIZED VIEW traces_without_authority_write_mirror
TO traces_without_authority
AS
SELECT
    trace_id,
    project_id,
    trace_start_time,
    name,
    user_id,
    session_id,
    git_ref,
    git_repo,
    input,
    output,
    metadata,
    ch_create_time,
    ch_update_time,
    environment,
    source
FROM traces;

INSERT INTO traces_without_authority
(
    trace_id,
    project_id,
    trace_start_time,
    name,
    user_id,
    session_id,
    git_ref,
    git_repo,
    input,
    output,
    metadata,
    ch_create_time,
    ch_update_time,
    environment,
    source
)
SELECT
    trace_id,
    project_id,
    trace_start_time,
    name,
    user_id,
    session_id,
    git_ref,
    git_repo,
    input,
    output,
    metadata,
    ch_create_time,
    ch_update_time,
    environment,
    source
FROM traces;

-- Replace the old backup with the freshest versioned table.
DROP TABLE IF EXISTS traces_before_authority;

RENAME TABLE
    traces TO traces_before_authority,
    traces_without_authority TO traces;

DROP TABLE traces_without_authority_write_mirror;
