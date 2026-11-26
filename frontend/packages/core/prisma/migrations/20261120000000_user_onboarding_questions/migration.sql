-- The sign-up questions' answers, on the user's onboarding row. Nullable columns and
-- one constant default, which PostgreSQL 11+ adds without rewriting the table. Bound
-- lock acquisition; roll back atomically on timeout and retry during a quiet window.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- AlterTable
ALTER TABLE "user_onboarding" ADD COLUMN "role" VARCHAR,
ADD COLUMN "company_input" VARCHAR,
ADD COLUMN "company_domain" VARCHAR,
ADD COLUMN "uses" VARCHAR[] DEFAULT ARRAY[]::VARCHAR[],
ADD COLUMN "source" VARCHAR,
ADD COLUMN "source_other" VARCHAR,
ADD COLUMN "questions_done_at" TIMESTAMP(6);

COMMIT;
