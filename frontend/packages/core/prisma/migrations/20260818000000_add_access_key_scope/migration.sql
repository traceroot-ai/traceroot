-- Existing keys predate scoping and are in active use, so the column is added
-- with DEFAULT 'admin': a migration must never silently narrow a live
-- credential, and the backfill this default performs is the whole point.
-- AlterTable
ALTER TABLE "access_keys" ADD COLUMN "scope" VARCHAR NOT NULL DEFAULT 'admin';

-- With the backfill done, the default flips to the safe scope. Anything that
-- inserts a key without asking for a scope — now or later — gets 'ingest'
-- rather than silently minting full project rights. A caller that genuinely
-- needs 'admin' has to say so.
ALTER TABLE "access_keys" ALTER COLUMN "scope" SET DEFAULT 'ingest';
