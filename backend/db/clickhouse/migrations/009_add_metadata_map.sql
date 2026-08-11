-- +goose Up
-- Make user metadata queryable without giving up the raw blob.
--
-- `metadata` is an opaque Nullable(String) JSON document on both tables: nothing can filter
-- it without a full scan and a per-row JSON parse. `metadata_map` is the queryable
-- projection of that same document -- one level deep, values stringified -- so a metadata
-- predicate becomes `metadata_map[key] = value` over a small Map column instead of a JSON
-- parse over a ZSTD blob.
--
-- MATERIALIZED, not DEFAULT, gives one implementation: an INSERT may not name a materialized
-- column, so ingestion cannot write a value of its own, and no insert column list can name
-- the column and fail all ingestion when the worker ships ahead of this migration.
-- `SELECT *` is unchanged, since materialized columns are excluded from it.
--
-- This file only ADDs the columns, which is metadata-only and rewrites no part. Making
-- EXISTING history answer metadata questions is the heavier step in 010, which is REQUIRED,
-- not an optimization: through the read shape we ship, a pre-ALTER part returns an EMPTY map
-- rather than a computed one, silently. Applying 009 alone is still a complete, safe deploy
-- -- ingestion is unchanged and everything answers correctly for data ingested from here on.
-- Only history stays blank until 010 runs.
--
-- The no-I/O projection is deliberately untouched, and the tempting justification for that
-- is wrong: including metadata_map would NOT put user metadata on the unfiltered list
-- query's path, because a query reads only the columns it references. The real cost is
-- storage and write amplification -- one more column materialised into every projection part
-- and rewritten on every merge, on the largest table we have. The price paid for leaving it
-- out is that a span-scope metadata predicate cannot use spans_no_io_by_start_time and drops
-- to the base table; metadata_map is the only column that scan reads which the projection
-- lacks. The follow-up, if that fallback hurts, is shaped like 008: DROP + ADD the projection
-- with metadata_map in the column list and out of its ORDER BY.

-- The rule the expression below implements, in the order it is applied:
--   1. Missing, empty, non-JSON, or non-object metadata yields an empty map --
--      JSONExtractKeysAndValuesRaw returns an empty array for all four.
--   2. Keys prefixed `traceroot.` are dropped: the namespace is ours, not the user's. Span
--      routing attributes and SDK identity land in the blob at ingest and sit on nearly
--      every span, so left in they outrank every real user key in the frequency-ordered
--      key list.
--   3. A JSON string value is stored unquoted and unescaped; every other value (number,
--      bool, null, nested object, array) is stored as its raw JSON text. Keys are one level
--      deep, so a nested object is a single opaque string value.
ALTER TABLE spans
    ADD COLUMN IF NOT EXISTS metadata_map Map(LowCardinality(String), String)
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
    );

-- Same column, same expression, on traces. One expression for both tables is what lets a
-- column and a filter agree on what a key is called and what its value looks like.
ALTER TABLE traces
    ADD COLUMN IF NOT EXISTS metadata_map Map(LowCardinality(String), String)
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
    );

-- No skip index on metadata_map -- DEFERRED pending measurement, not ruled out. A bloom
-- filter over mapKeys(metadata_map) is the obvious fit, and the predicate FORM is already
-- right for one: `_keyed_map_match` emits `mapContains(metadata_map, key) AND
-- metadata_map[key] OP value`, and that explicit key-membership conjunct is exactly what
-- makes such an index actionable.
--
-- What blocks it is POSITION, not form. The conjunct sits in the OUTER WHERE, above the
-- `LIMIT 1 BY project_id, trace_id, span_id` that dedups the ReplacingMergeTree. That order
-- is required for correctness -- predicate first would match a superseded map -- and
-- ClickHouse does not push a predicate through LIMIT BY, so granule selection happens before
-- the predicate exists and the index would be maintained on write, never consulted. Key
-- discovery has no key predicate at all: it arrayJoins mapKeys over the window, so nothing
-- can prune it.
--
-- The restructure that WOULD make an index live, so the next person need not rediscover it:
-- prefilter candidate spans with a plain index-eligible scan on the base table (project_id,
-- the same time bound, and the same two map conjuncts, with no LIMIT BY above it), then run
-- the existing deduped scan restricted to the resulting (project_id, trace_id, span_id)
-- triples and re-apply the predicate. Correctness holds because the candidate set is a
-- superset of the true matches, and because restricting by whole triples cannot change which
-- row wins within a group -- the triple IS the LIMIT BY key. The re-check discards
-- candidates whose only match lives on a superseded version. What is unmeasured is whether
-- the prefilter is selective enough to earn a second scan; on a high-frequency key it plainly
-- would not be.
--
-- The trace-level half needs none of that -- an inline predicate with no LIMIT BY between it
-- and the granules -- but gets no index either, because traces is the small table, already
-- pruned by the monthly partition and the sort key. Next step for whoever picks this up:
-- benchmark the restructured span query at realistic key cardinality FIRST, and add the index
-- only if the prefilter pays.

-- +goose Down
ALTER TABLE spans  DROP COLUMN IF EXISTS metadata_map;
ALTER TABLE traces DROP COLUMN IF EXISTS metadata_map;
