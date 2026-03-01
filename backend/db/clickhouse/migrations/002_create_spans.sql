-- +goose Up
CREATE TABLE IF NOT EXISTS spans
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
    ch_update_time      DateTime64(3) DEFAULT now64(3)
)
ENGINE = ReplacingMergeTree(ch_update_time)
PARTITION BY toYYYYMM(span_start_time)
ORDER BY (project_id, span_kind, toDate(span_start_time), span_id);

-- +goose Down
DROP TABLE IF EXISTS spans;
