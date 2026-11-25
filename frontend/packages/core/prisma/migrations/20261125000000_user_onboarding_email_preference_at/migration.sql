-- Product-email choices and their sync to the provider: when the person made the
-- latest choice that applied (so an older one arriving later is ignored), a count
-- of choices applied (compared by the provider sync, since two choices can share
-- a millisecond), when the latest provider write started, when the scheduled run
-- last confirmed the provider, and which choice the provider acknowledged.
-- Nullable columns and one with a constant default, added without rewriting the
-- table. Bound lock acquisition; roll back atomically on timeout and retry during
-- a quiet window.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- AlterTable
ALTER TABLE "user_onboarding" ADD COLUMN "email_preference_at" TIMESTAMP(3),
ADD COLUMN "email_preference_version" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "email_provider_write_at" TIMESTAMP(3),
ADD COLUMN "email_provider_settled_at" TIMESTAMP(3),
ADD COLUMN "email_provider_ack_version" INTEGER;

COMMIT;
