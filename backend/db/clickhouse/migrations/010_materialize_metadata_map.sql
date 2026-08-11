-- +goose Up

-- Rewrite pre-009 parts so they STORE metadata_map, making existing history answer metadata
-- filters, render the metadata column, and contribute discovered keys.
--
-- Split from 009 because the two halves have different costs and failure modes, NOT because
-- this half is optional. Both deploy paths run goose over the whole migrations directory --
-- docker-compose's `migrate-clickhouse` service, which every app service gates on with
-- `service_completed_successfully`, and the helm post-install/pre-upgrade Job -- so this runs
-- automatically and unattended wherever 009 runs. There is no low-traffic window to choose
-- and no supported way to hold it back.
--
-- Why it is required, and how that differs from 008's deliberate refusal to materialize:
-- there, a part missing the rebuilt projection is still READ correctly (the query falls back
-- to the base table, same rows, only slower) and parts pick it up as they merge, so skipping
-- costs only time. Here, skipping is a wrong ANSWER and nothing arrives on its own. A part
-- written before 009's ALTER does not store the column, and what decides whether ClickHouse
-- computes it on read is not whether the query also reads `metadata` -- it is whether the
-- read is a WHOLE-column read or a subcolumn one. Several of our reads DO take the blob --
-- trace detail, the per-span and bulk I/O fetches, and `SELECT *` in the internal router --
-- and that is not what settles the answer either way. `SELECT metadata_map` on a pre-ALTER
-- part returns the correctly computed map with no `metadata` in the query at all. But
-- length(metadata_map), metadata_map[key], mapContains() and mapKeys() all read back EMPTY:
-- optimize_functions_to_subcolumns rewrites them into subcolumn reads, and a subcolumn read
-- never evaluates the default expression. Naming `metadata` in the same SELECT list does
-- restore correct values for those expressions -- but it does not rescue the read shape we
-- actually ship. `mapContains(metadata_map, key) AND metadata_map[key] = value` in a WHERE
-- matches ZERO rows even when the query also selects `metadata`, because the filter stage
-- reads the subcolumns before the blob column enters the block. That predicate is exactly
-- what #1833 ships, so a pre-009 part answers a metadata filter with no error and no rows:
-- a trace that behaves as though it carried no metadata. Reproduced on ClickHouse 26.3.3
-- against a pre-ALTER row; optimize_functions_to_subcolumns has defaulted on since 24.8, so
-- the 25.2 server we pin behaves the same way.
--
-- The deploy-time hazard: the mutation is asynchronous (mutations_sync=0 by default), so the
-- statements return as soon as it is QUEUED. History becomes filterable gradually in the
-- background, unthrottled, competing with live ingestion -- and goose records the version as
-- applied at the moment of queueing, not completion. A mutation that never finishes, killed
-- by a restart, disk pressure, or a deliberate KILL MUTATION, leaves history permanently
-- unbackfilled, with nothing signalling it and no goose re-run, since the version counts as
-- applied.
--
-- So verify rather than assume, on the first deploy that applies this file:
--   SELECT * FROM system.mutations WHERE table IN ('spans','traces') AND NOT is_done;
-- Empty means the rewrite finished. A lingering row is in progress; a non-empty
-- latest_fail_reason is the case above. Recovery is to re-issue the statement by hand --
-- MATERIALIZE COLUMN is idempotent -- so the lack of a goose re-run path costs nothing but
-- the noticing. An install large enough that the one-shot rewrite is itself the problem can
-- re-drive it per partition, newest first, accepting that older partitions answer empty until
-- their turn:
--   ALTER TABLE spans MATERIALIZE COLUMN metadata_map IN PARTITION '202607';

ALTER TABLE spans  MATERIALIZE COLUMN metadata_map;
ALTER TABLE traces MATERIALIZE COLUMN metadata_map;

-- +goose Down

-- Deliberately a no-op. There is no inverse that un-stores a value the expression already
-- defines, and un-storing it would change no answer, since a stored map and a computed map
-- are the same map. The reversible half of this feature is 009's DROP COLUMN, so rolling back
-- means rolling back past 009. The statement below exists only to give goose something to
-- execute.
SELECT 1;
