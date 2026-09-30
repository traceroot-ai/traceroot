-- Bound both lock acquisition and index work. Roll back atomically on timeout;
-- resolve the failed migration and retry during a quiet deployment window.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
ALTER TABLE "audit_logs"
  ADD COLUMN "actor_email" VARCHAR,
  ADD COLUMN "target_user_id" VARCHAR,
  ADD COLUMN "target_email" VARCHAR,
  ADD COLUMN "impersonation_session_id" VARCHAR,
  ADD COLUMN "outcome" VARCHAR,
  ADD COLUMN "expires_at" TIMESTAMP(6),
  ADD COLUMN "ended_at" TIMESTAMP(6),
  ADD COLUMN "end_reason" VARCHAR;
CREATE INDEX "ix_audit_impersonation_session_id" ON "audit_logs"("impersonation_session_id");
COMMIT;
