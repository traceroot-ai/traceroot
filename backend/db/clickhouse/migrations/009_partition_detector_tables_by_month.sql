-- +goose Up

-- Rebuild `detector_runs` and `detector_findings` with a monthly partition key
-- so the time-bounded reads can prune instead of scanning a tenant's whole
-- history.
--
-- Both tables were created (003) with no PARTITION BY, and `timestamp` is in
-- neither sort key (`(project_id, detector_id, run_id)` /
-- `(project_id, trace_id, finding_id)`). Four reads filter on `timestamp` and
-- none of them can prune: billing metering and the digest sample
-- (`/usage/details`, `/detector-window-summary` in rest/routers/internal.py),
-- the paginated runs list, and the findings list
-- (rest/services/detector_reader.py). Each reads the project's entire run or
-- finding history and discards everything outside the window, and the discarded
-- share grows every month the project stays alive.
--
-- WHY NOT THE MINMAX SKIP INDEX. `ALTER TABLE ... ADD INDEX ts TYPE minmax` is
-- the cheap in-place option, and it does nothing here. A minmax index prunes a
-- granule only when the granule's value range is narrow, which requires the
-- indexed column to be correlated with the sort order. `run_id` and
-- `finding_id` are sha256-derived, so within one (project, detector) group the
-- rows are in effectively random time order and every granule spans the whole
-- retained history. Measured on ClickHouse 26.8.1 with 8M runs over 180 days,
-- one project, one month asked for: the skip index pruned 245 granules to 245.
-- Not a smaller win than partitioning, no win at all. The same table with
-- PARTITION BY toYYYYMM(timestamp) read 43 granules for the identical answer.
--
-- ClickHouse cannot add a partition key in place, so this is the create-new +
-- backfill + atomic-rename rebuild that migration 005 established for `spans`,
-- with the same constraints: the multi-table RENAME is atomic on a single node,
-- there is deliberately NO concurrent-write catch-up step, and the pre-migration
-- tables are kept aside as a backstop rather than dropped here.
--
-- DEDUP BOUNDARY, CHECKED. Both tables are ReplacingMergeTree(timestamp) whose
-- duplicates are idempotent BullMQ retries sharing a deterministic id, and the
-- partition key is now derived from `timestamp`, which is also the version
-- column. A retry therefore carries a different timestamp and a retry that lands
-- on the far side of a month boundary goes to a different partition, where the
-- engine will never physically collapse it, because merges do not cross
-- partitions.
--
-- Reads are unaffected, and this was measured rather than assumed. On ClickHouse
-- 26.8.1 the same run_id written either side of a month boundary produces two
-- parts and two raw rows, and `SELECT ... FINAL` returns one row from the
-- partitioned table exactly as it does from the unpartitioned one, because FINAL
-- merges across partitions unless
-- `do_not_merge_across_partitions_select_final` is turned on. The reads that do
-- not use FINAL dedup by `uniqExact(run_id)` (billing), `GROUP BY detector_id,
-- run_id` (window summary) or `LIMIT 1 BY finding_id` (findings list), none of
-- which is partition-local either. What remains is storage, one uncollapsed row
-- per retry that happened to cross a month boundary.
--
-- The sort keys stay exactly as 003 wrote them. Putting `timestamp` into a sort
-- key would prune beautifully and destroy the dedup, because a retry's newer
-- version would then sort as a different row and never collapse at all.

-- Idempotent cleanup: if a prior run died between RENAME and DROP, these may
-- still exist. A successful run leaves neither behind.
DROP TABLE IF EXISTS detector_runs_v2;
DROP TABLE IF EXISTS detector_runs_old;
DROP TABLE IF EXISTS detector_findings_v2;
DROP TABLE IF EXISTS detector_findings_old;

-- Step 1 — replacement tables. Column lists are the EXACT live schema (003 base
-- + `self_traced` from 007) and are spelled out in every INSERT, never
-- `SELECT *`, so a future ALTER ADD COLUMN cannot silently mis-map a column the
-- way a positional copy would. Sort keys are unchanged: the dedup key must stay
-- free of `timestamp`, or a retry's newer version would sort as a new row and
-- never collapse at all.
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

-- Step 2 — backfill (explicit column lists, never SELECT *).
INSERT INTO detector_runs_v2
(run_id, detector_id, project_id, trace_id, finding_id, status, timestamp, self_traced)
SELECT run_id, detector_id, project_id, trace_id, finding_id, status, timestamp, self_traced
FROM detector_runs;

INSERT INTO detector_findings_v2
(finding_id, project_id, trace_id, summary, payload, timestamp)
SELECT finding_id, project_id, trace_id, summary, payload, timestamp
FROM detector_findings;

-- Step 3 — atomic swap. One statement, atomic on a single node.
RENAME TABLE
    detector_runs     TO detector_runs_old,     detector_runs_v2     TO detector_runs,
    detector_findings TO detector_findings_old, detector_findings_v2 TO detector_findings;

-- Step 4 — KEEP the *_old tables as a backstop; they are intentionally NOT
-- dropped here. After confirming row parity in the target environment, drop them
-- explicitly (manually or in a follow-up migration):
--   DROP TABLE IF EXISTS detector_runs_old;
--   DROP TABLE IF EXISTS detector_findings_old;
--
-- REQUIRED PROCEDURE — as in 005, run this with detector ingestion paused (scale
-- traceroot-detector to 0) for the backfill+swap window, then resume. There is
-- deliberately no concurrent-write catch-up step; the *_old tables hold anything
-- nonetheless written mid-rebuild.

-- +goose Down

-- Reverse: rebuild both tables without a partition key.
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
SELECT run_id, detector_id, project_id, trace_id, finding_id, status, timestamp, self_traced
FROM detector_runs;

INSERT INTO detector_findings_v2
(finding_id, project_id, trace_id, summary, payload, timestamp)
SELECT finding_id, project_id, trace_id, summary, payload, timestamp
FROM detector_findings;

RENAME TABLE
    detector_runs     TO detector_runs_old,     detector_runs_v2     TO detector_runs,
    detector_findings TO detector_findings_old, detector_findings_v2 TO detector_findings;

-- As in the Up section: run with ingestion paused, keep the *_old tables as a
-- backstop, and drop them manually after verifying parity.
