-- The severity the last notification attempt announced, so a page that never
-- reached Slack can be replayed as what it said rather than what the rule reads
-- now. Nullable and without a default: adding it rewrites no rows, and a null
-- (every attempt recorded before this) is never replayed.
BEGIN;
SET LOCAL lock_timeout = '5s';
ALTER TABLE "alerts" ADD COLUMN "last_notify_severity" VARCHAR;
COMMIT;
