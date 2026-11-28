-- Existing keys predate scoping and are in active use, so they default to
-- "admin": a migration must never silently narrow a live credential.
-- AlterTable
ALTER TABLE "access_keys" ADD COLUMN "scope" VARCHAR NOT NULL DEFAULT 'admin';
