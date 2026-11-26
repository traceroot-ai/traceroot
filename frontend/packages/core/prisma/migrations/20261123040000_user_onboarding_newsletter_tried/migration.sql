-- When adding a user to the newsletter segment last failed, so each run tries
-- those not tried yet first. One nullable column, added without rewriting the
-- table. Bound lock acquisition; roll back atomically on timeout and retry
-- during a quiet window.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- AlterTable
ALTER TABLE "user_onboarding" ADD COLUMN "newsletter_tried_at" TIMESTAMP(6);

COMMIT;
