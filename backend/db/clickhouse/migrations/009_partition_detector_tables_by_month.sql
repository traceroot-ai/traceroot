-- +goose Up

-- Partition detector_runs and detector_findings by month so the time-windowed
-- billing / badge-count / digest queries can prune.
--
-- Both tables were created unpartitioned (003), and `timestamp` is in neither
-- sort key ((project_id, detector_id, run_id) / (project_id, trace_id,
-- finding_id)) nor covered by an index. Every query that filters
-- `timestamp >= ? AND timestamp < ?` — usage metering, the runs/findings window
-- summary behind the detector badge counts, and the digest sample — therefore
-- reads the project's ENTIRE run/finding history and discards all but the
-- window. That history only grows (one run + one finding per detector
-- evaluation, and self-tracing evaluates far more traces than before), so the
-- cost climbs with tenant age forever.
--
-- toYYYYMM(timestamp) makes the month a hard partition boundary, so a recent-
-- window query prunes to the current month's parts regardless of how old parts
-- have merged — a guarantee a minmax skip index cannot give, because these
-- tables sort by a hashed run_id/finding_id and a merged multi-month part
-- scatters timestamps across every granule. The tables are small (one row per
-- evaluation, not many per trace), so the rebuild is cheap.
--
-- ClickHouse cannot add a partition key in place, so this is the same
-- create-new + backfill + atomic-rename rebuild as 005, keeping the old tables
-- as a backstop. Column lists are the EXACT live schema (003 base +
-- self_traced from 007) and are spelled out in every INSERT (never SELECT *) so
-- a future ADD COLUMN cannot silently mis-map. The sort keys and the
-- ReplacingMergeTree version column (timestamp) are unchanged, so dedup
-- semantics are identical.

-- Idempotent cleanup from a prior partial run: a successful run leaves neither.
DROP TABLE IF EXISTS detector_runs_v2;
DROP TABLE IF EXISTS detector_runs_old;
DROP TABLE IF EXISTS detector_findings_v2;
DROP TABLE IF EXISTS detector_findings_old;

-- Step 1 — replacement tables: identical schema + sort key, now partitioned.
CREATE TABLE detector_runs_v2
(
    run_id      String DEFAULT toString(generateUUIDv4()),
    detector_id String,
    project_id  String,
    trace_id    String,
    finding_id  Nullable(String),
    status      String DEFAULT 'completed',
    timestamp   DateTime64(3) DEFAULT now64(3),
    self_traced Bool DEFAULT false
)
ENGINE = ReplacingMergeTree(timestamp)
PARTITION BY toYYYYMM(timestamp)
ORDER BY (project_id, detector_id, run_id);

CREATE TABLE detector_findings_v2
(
    finding_id  String DEFAULT toString(generateUUIDv4()),
    project_id  String,
    trace_id    String,
    summary     String,
    payload     String,
    timestamp   DateTime64(3) DEFAULT now64(3)
)
ENGINE = ReplacingMergeTree(timestamp)
PARTITION BY toYYYYMM(timestamp)
ORDER BY (project_id, trace_id, finding_id);

-- Step 2 — backfill (explicit column list, never SELECT *).
INSERT INTO detector_runs_v2
    (run_id, detector_id, project_id, trace_id, finding_id, status, timestamp, self_traced)
SELECT
    run_id, detector_id, project_id, trace_id, finding_id, status, timestamp, self_traced
FROM detector_runs;

INSERT INTO detector_findings_v2
    (finding_id, project_id, trace_id, summary, payload, timestamp)
SELECT
    finding_id, project_id, trace_id, summary, payload, timestamp
FROM detector_findings;

-- Step 3 — atomic swap (single statement; atomic on a single node).
RENAME TABLE
    detector_runs TO detector_runs_old, detector_runs_v2 TO detector_runs,
    detector_findings TO detector_findings_old, detector_findings_v2 TO detector_findings;

-- Step 4 — KEEP the _old tables as a backstop; intentionally NOT dropped here.
-- After confirming row parity in the target environment, drop them explicitly
-- (manually or in a follow-up migration):
--   DROP TABLE IF EXISTS detector_runs_old;
--   DROP TABLE IF EXISTS detector_findings_old;
--
-- REQUIRED PROCEDURE — there is deliberately NO concurrent-write catch-up step.
-- Run with detector ingestion paused (scale traceroot-worker and
-- traceroot-detector to 0) for the backfill+swap window, then resume. Detector
-- writes go through the async queue, so a pause only delays ClickHouse writes;
-- nothing is lost and queued work flushes on resume. The _old tables remain as
-- the backstop for any row nonetheless written mid-rebuild; ReplacingMergeTree
-- (timestamp) makes a manual reconciliation from them idempotent.

-- +goose Down

-- Reverse: rebuild the tables unpartitioned (the 003/007 layout).
DROP TABLE IF EXISTS detector_runs_v2;
DROP TABLE IF EXISTS detector_runs_old;
DROP TABLE IF EXISTS detector_findings_v2;
DROP TABLE IF EXISTS detector_findings_old;

CREATE TABLE detector_runs_v2
(
    run_id      String DEFAULT toString(generateUUIDv4()),
    detector_id String,
    project_id  String,
    trace_id    String,
    finding_id  Nullable(String),
    status      String DEFAULT 'completed',
    timestamp   DateTime64(3) DEFAULT now64(3),
    self_traced Bool DEFAULT false
)
ENGINE = ReplacingMergeTree(timestamp)
ORDER BY (project_id, detector_id, run_id);

CREATE TABLE detector_findings_v2
(
    finding_id  String DEFAULT toString(generateUUIDv4()),
    project_id  String,
    trace_id    String,
    summary     String,
    payload     String,
    timestamp   DateTime64(3) DEFAULT now64(3)
)
ENGINE = ReplacingMergeTree(timestamp)
ORDER BY (project_id, trace_id, finding_id);

INSERT INTO detector_runs_v2
    (run_id, detector_id, project_id, trace_id, finding_id, status, timestamp, self_traced)
SELECT
    run_id, detector_id, project_id, trace_id, finding_id, status, timestamp, self_traced
FROM detector_runs;

INSERT INTO detector_findings_v2
    (finding_id, project_id, trace_id, summary, payload, timestamp)
SELECT
    finding_id, project_id, trace_id, summary, payload, timestamp
FROM detector_findings;

RENAME TABLE
    detector_runs TO detector_runs_old, detector_runs_v2 TO detector_runs,
    detector_findings TO detector_findings_old, detector_findings_v2 TO detector_findings;

-- As above: run with ingestion paused; keep the _old tables as a backstop and
-- drop them manually after verifying parity.
