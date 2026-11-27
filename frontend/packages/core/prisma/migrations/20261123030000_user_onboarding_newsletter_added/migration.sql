-- When a user was added to the newsletter segment, so nobody is added twice and
-- an interrupted import resumes where it stopped. One nullable column, added
-- without rewriting the table. Bound lock acquisition; roll back atomically on
-- timeout and retry during a quiet window.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- AlterTable
ALTER TABLE "user_onboarding" ADD COLUMN "newsletter_added_at" TIMESTAMP(6);

COMMIT;
