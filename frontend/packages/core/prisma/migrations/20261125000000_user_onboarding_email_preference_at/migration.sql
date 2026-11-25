-- When a person made the latest unsubscribe or resubscribe choice that applied,
-- so an older choice that arrives later is ignored. One nullable column, added
-- without rewriting the table. Bound lock acquisition; roll back atomically on
-- timeout and retry during a quiet window.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- AlterTable
ALTER TABLE "user_onboarding" ADD COLUMN "email_preference_at" TIMESTAMP(3);

COMMIT;
