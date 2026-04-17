-- +goose Up
CREATE TABLE IF NOT EXISTS detector_runs
(
    run_id      UUID DEFAULT generateUUIDv4(),
    detector_id String,
    project_id  String,
    trace_id    String,
    finding_id  Nullable(String),
    status      String DEFAULT 'completed',
    timestamp   DateTime64(3) DEFAULT now64(3)
)
ENGINE = MergeTree()
ORDER BY (project_id, detector_id, timestamp);

CREATE TABLE IF NOT EXISTS detector_findings
(
    finding_id  String DEFAULT toString(generateUUIDv4()),
    project_id  String,
    trace_id    String,
    summary     String,
    payload     String,
    timestamp   DateTime64(3) DEFAULT now64(3)
)
ENGINE = MergeTree()
ORDER BY (project_id, trace_id, timestamp);

ALTER TABLE spans  ADD COLUMN IF NOT EXISTS environment Nullable(String);
ALTER TABLE traces ADD COLUMN IF NOT EXISTS environment Nullable(String);

-- +goose Down
DROP TABLE IF EXISTS detector_runs;
DROP TABLE IF EXISTS detector_findings;
ALTER TABLE spans  DROP COLUMN IF EXISTS environment;
ALTER TABLE traces DROP COLUMN IF EXISTS environment;
