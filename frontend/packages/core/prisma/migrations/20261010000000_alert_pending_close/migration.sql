-- The open page an edit or a resume discarded, kept until the worker has posted
-- its close to Slack. Nullable and without a default: adding it rewrites no
-- rows, and a null (every rule with nothing to close) is never read.
BEGIN;
SET LOCAL lock_timeout = '5s';
ALTER TABLE "alerts" ADD COLUMN "pending_close" JSONB;
COMMIT;
