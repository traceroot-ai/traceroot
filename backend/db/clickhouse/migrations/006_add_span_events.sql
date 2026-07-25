-- +goose Up
-- OTEL span events, most importantly exception events: record_exception() in
-- both official SDKs attaches exception.type/message/stacktrace as a span
-- event, and until now the transform dropped events entirely — the stack trace
-- of a failed span never reached storage, the trace viewer, or the detector /
-- RCA context. Stored as one JSON blob (a normalized [{name, timestamp,
-- attributes}] array) rather than a Nested column: events are read whole per
-- span like input/output/metadata, never filtered on in SQL, and a blob
-- absorbs new event shapes with zero migration. Deliberately NOT added to the
-- spans_no_io_by_start_time projection — it is a heavy blob and list/skeleton
-- reads must never touch it. Nullable so existing rows and event-less spans
-- stay NULL (no storage cost, read path treats NULL as "no events").
ALTER TABLE spans
    ADD COLUMN IF NOT EXISTS events Nullable(String) CODEC(ZSTD(3));

-- +goose Down
ALTER TABLE spans
    DROP COLUMN IF EXISTS events;
