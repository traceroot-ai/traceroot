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
-- Why it ships, and how that differs from 008's deliberate refusal to materialize: there, a
-- part missing the rebuilt projection is still READ correctly (the query falls back to the
-- base table, same rows, only slower) and parts pick it up as they merge, so skipping costs
-- only time. Here the risk is a wrong ANSWER, and whether it bites depends on the SERVER
-- VERSION, not the query text. A part written before 009's ALTER does not store the column;
-- what decides whether ClickHouse computes it on read is whether the optimizer leaves the
-- read as a WHOLE-column read (which evaluates the MATERIALIZED expression -- `SELECT
-- metadata_map` on a pre-ALTER part returns the correctly computed map with no `metadata`
-- in the query at all) or rewrites it into a SUBCOLUMN read, which never evaluates the
-- default and returns the type default instead: length() 0, mapKeys() []. That rewrite is
-- optimize_functions_to_subcolumns (default on since 24.8), and its REACH grows by release.
-- On 25.2, the version we pin, it covers select-list length/mapKeys/mapContains -- shapes
-- we do not ship -- while WHERE-context mapContains and metadata_map[key] stay ordinary
-- functions, so every read #1833 ships answers correctly on pre-ALTER parts (verified on
-- 25.2.2.39 against this file's expression, Wide and Compact parts, native and HTTP for the
-- filter shape). On 26.3 the rewrite also reaches metadata_map[key] and the WHERE context,
-- and there the shipped trace-half predicate `mapContains(metadata_map, key) AND
-- metadata_map[key] = value` matches ZERO rows on a pre-ALTER part, even when the query
-- also selects `metadata` (verified on 26.3.17.110); the span semi-join and key discovery
-- still answer correctly on both versions, because their subqueries project the whole
-- column. Merges do bake the stored column into parts they rewrite, but settled partitions
-- may never merge again, so history does not converge on its own. So 010 is not fixing a
-- wrong answer the pinned server gives today. It is what makes old history's answers
-- survive a ClickHouse upgrade (>= 26.x silently flips inline filters on unmaterialized
-- parts from correct to empty), keeps ad-hoc and future subcolumn-shaped reads honest, and
-- spares every old-part read a per-row JSON parse of the blob.
--
-- The deploy-time hazard: the mutation is asynchronous (mutations_sync=0 by default), so the
-- statements return as soon as it is QUEUED. History becomes filterable gradually in the
-- background, unthrottled, competing with live ingestion -- and goose records the version as
-- applied at the moment of queueing, not completion. The mutation itself is durable table
-- metadata: a restart RESUMES it (verified -- a queued MATERIALIZE COLUMN survived a server
-- restart and completed unprompted), and a failing one retries forever with the error in
-- system.mutations.latest_fail_reason. What abandons it permanently is KILL MUTATION -- and
-- nothing signals that afterwards or re-runs goose, since the version already counts as
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
