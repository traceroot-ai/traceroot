-- +goose Up
CREATE TABLE IF NOT EXISTS traces
(
    trace_id            String,
    project_id          String,
    trace_start_time    DateTime64(3),
    name                String,
    user_id             Nullable(String),
    session_id          Nullable(String),
    environment         String DEFAULT 'default',
    release             Nullable(String),
    input               Nullable(String) CODEC(ZSTD(3)),
    output              Nullable(String) CODEC(ZSTD(3)),
    ch_create_time      DateTime64(3) DEFAULT now64(3),
    ch_update_time      DateTime64(3) DEFAULT now64(3)
)
ENGINE = ReplacingMergeTree(ch_update_time)
PARTITION BY toYYYYMM(trace_start_time)
ORDER BY (project_id, toDate(trace_start_time), trace_id);

-- +goose Down
DROP TABLE IF EXISTS traces;
