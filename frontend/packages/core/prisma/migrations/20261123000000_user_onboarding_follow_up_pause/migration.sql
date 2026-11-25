-- Pausing follow-up emails, and recording an unsubscribe, on the user's onboarding
-- row. Nullable columns, which PostgreSQL adds without rewriting the table. Bound
-- lock acquisition; roll back atomically on timeout and retry during a quiet window.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- AlterTable
ALTER TABLE "user_onboarding" ADD COLUMN "follow_ups_paused_at" TIMESTAMP(6),
ADD COLUMN "follow_ups_pause_reason" VARCHAR,
ADD COLUMN "unsubscribed_at" TIMESTAMP(6);

COMMIT;
