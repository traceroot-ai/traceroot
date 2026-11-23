-- Every UTC day counted in a user's first week, so a day whose report arrives after
-- a later day's still counts once. One column with a constant default, which
-- PostgreSQL 11+ adds without rewriting the table. Bound lock acquisition; roll back
-- atomically on timeout and retry during a quiet window.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- AlterTable
ALTER TABLE "user_onboarding" ADD COLUMN "counted_days" DATE[] DEFAULT ARRAY[]::DATE[];

COMMIT;
