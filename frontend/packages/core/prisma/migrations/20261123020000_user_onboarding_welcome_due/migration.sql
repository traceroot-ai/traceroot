-- When the welcome email falls due at the latest, for someone who signed up on
-- the cloud service. Null for everyone else, including everyone who signed up
-- before it was added, so no existing account is sent a welcome. One nullable
-- column, added without rewriting the table. Bound lock acquisition; roll back
-- atomically on timeout and retry during a quiet window.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- AlterTable
ALTER TABLE "user_onboarding" ADD COLUMN "welcome_due_at" TIMESTAMP(6);

COMMIT;
