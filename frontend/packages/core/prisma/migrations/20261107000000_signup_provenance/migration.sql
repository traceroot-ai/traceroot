BEGIN;
SET LOCAL lock_timeout = '5s';

-- How each account was created ("email", "google", ... or "admin"), written
-- with the account, and when the sign-up webhook's receiver acknowledged it.
-- Existing accounts keep NULL for both: how they were created was never
-- recorded, so the weekly replay leaves them to an explicitly approved list.
ALTER TABLE "users" ADD COLUMN "signup_method" VARCHAR;
ALTER TABLE "users" ADD COLUMN "signup_delivered_at" TIMESTAMP(6);

COMMIT;
