-- +goose Up

-- One row per sampled trace: what the trace was asked to do, in a sentence or
-- two, and that text's embedding. The summary is the only thing embedded; the
-- raw trace never is. `lens` and `digest_version` are columns so another
-- question can be asked of the same trace later without a new table, and a
-- change of prompt or model leaves old rows identifiable.
-- A re-written row for the same trace replaces the earlier one on merge.
CREATE TABLE IF NOT EXISTS trace_task_digests
(
    project_id       String,
    trace_id         String,
    lens             LowCardinality(String),
    trace_time       DateTime64(3),
    summary          String CODEC(ZSTD(3)),
    embedding        Array(Float32),
    summary_model    LowCardinality(String),
    embedding_model  LowCardinality(String),
    digest_version   UInt16,
    -- Model spend for this row (summary plus embedding), in US dollars.
    cost_usd         Float64,
    created_at       DateTime64(3) DEFAULT now64(3)
)
ENGINE = ReplacingMergeTree(created_at)
PARTITION BY toYYYYMM(trace_time)
ORDER BY (project_id, lens, trace_id);

-- The groups of one fit. A fit writes all of its groups under one fit_id;
-- `group_id` is the identity that carries over from one fit to the next, so
-- filters and trend lines keep meaning the same thing. `center` and `reach`
-- (largest cosine distance a member may have) are what assignment uses.
CREATE TABLE IF NOT EXISTS task_groups
(
    project_id   String,
    lens         LowCardinality(String),
    fit_id       String,
    group_id     String,
    name         String,
    description  String,
    center       Array(Float32),
    reach        Float32,
    size         UInt32,
    -- Summaries closest to the center, for display and for naming.
    exemplar_trace_ids Array(String),
    fitted_at    DateTime64(3)
)
ENGINE = MergeTree
ORDER BY (project_id, lens, fitted_at, group_id);

-- Which group each digested trace belongs to under the current fit. An empty
-- group_id means "no group" (noise, or outside every reach). `source` says
-- whether the fit placed the trace or the nearest-center step did.
CREATE TABLE IF NOT EXISTS trace_group_members
(
    project_id   String,
    lens         LowCardinality(String),
    trace_id     String,
    trace_time   DateTime64(3),
    group_id     String,
    fit_id       String,
    distance     Float32,
    source       LowCardinality(String),
    assigned_at  DateTime64(3)
)
ENGINE = ReplacingMergeTree(assigned_at)
PARTITION BY toYYYYMM(trace_time)
ORDER BY (project_id, lens, trace_id);

-- +goose Down

DROP TABLE IF EXISTS trace_group_members;
DROP TABLE IF EXISTS task_groups;
DROP TABLE IF EXISTS trace_task_digests;
