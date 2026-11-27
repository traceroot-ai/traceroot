BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

ALTER TABLE "user_onboarding"
  ADD COLUMN "role_other" VARCHAR(200),
  ADD COLUMN "uses_other" VARCHAR(200);

COMMIT;
