-- When the caller decided the latest pause or resume applied to a user's
-- follow-up emails, so an older decision that arrives later is ignored. One
-- nullable column, added without rewriting the table. Bound lock acquisition;
-- roll back atomically on timeout and retry during a quiet window.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- AlterTable
ALTER TABLE "user_onboarding" ADD COLUMN "follow_ups_intent_at" TIMESTAMP(3);

COMMIT;
