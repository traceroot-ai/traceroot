-- The last UTC day each user's trace_count was sent, and the claim a scheduled tick
-- holds while sending it, so the count is sent once a day however ticks overlap,
-- retry or die halfway. Two nullable columns, no defaults, so no table rewrite.
-- Bound lock acquisition; roll back atomically on timeout and retry during a quiet
-- window.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- AlterTable
ALTER TABLE "user_onboarding" ADD COLUMN "trace_count_reported_on" DATE,
ADD COLUMN "trace_count_claimed_at" TIMESTAMP(6);

COMMIT;
