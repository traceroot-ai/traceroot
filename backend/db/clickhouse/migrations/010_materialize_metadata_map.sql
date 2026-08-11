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
-- written before 009's ALTER does not store the column, and ClickHouse computes it on read
-- ONLY when the query also reads `metadata` -- which ours never do, since reading the blob is
-- the cost this column exists to avoid. So the map reads back EMPTY rather than computed: no
-- error, just a trace that answers every metadata filter as though it carried no metadata.
-- Verified on ClickHouse 25.2 against a pre-ALTER row, where selecting the map alone returns
-- length 0 and selecting it alongside `metadata` returns length 1.
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
