BEGIN;
SET LOCAL lock_timeout = '5s';
ALTER TABLE "projects" ADD COLUMN "last_ingested_at" TIMESTAMP(6);
COMMIT;
