-- +goose Up

-- Which signal each detector hit was assigned to: the ClickHouse copy of the
-- Postgres signal_hits table, written by the signal assignment worker after
-- each hit's Postgres transaction commits. The worker reads it to find hits
-- that are still waiting (triggered detector_runs rows with no row here), so a
-- hit whose copy failed to land is assigned again, found to be a duplicate in
-- Postgres, and its copy re-written.
--
-- One row per run_id. A later write for the same run (a user moving the hit or
-- merging its signal) carries a newer assigned_at and replaces the earlier row
-- on merge. `embedding` is the hit's text-embedding-3-small vector (empty for
-- hits grouped without one), kept so later drift checks and all-hits retrieval
-- need no backfill. An empty `signal_id` marks a hit the worker gave up on
-- after it kept failing; it belongs to no signal and is no longer waiting.
CREATE TABLE IF NOT EXISTS signal_assignments
(
    project_id       String,
    detector_id      String,
    run_id           String,
    trace_id         String,
    signal_id        String,
    embedding        Array(Float32),
    score            Nullable(Float64),
    criteria_version Nullable(UInt32),
    -- The replacement version: the hit's assigned_at in Postgres, at the same
    -- microsecond precision. A user's move stamps a time later than the hit's
    -- previous one, so the newest placement wins whatever order writes land in.
    assigned_at      DateTime64(6)
)
ENGINE = ReplacingMergeTree(assigned_at)
ORDER BY (project_id, detector_id, run_id);

-- +goose Down

DROP TABLE IF EXISTS signal_assignments;
