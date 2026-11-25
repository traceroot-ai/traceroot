-- When Slack accepted a page from the breach a rule is in now, so a close is only
-- posted for a page the channel actually saw. Nullable and without a default:
-- adding it rewrites no rows, and a rule already paging when this ships gets its
-- value on its next delivered page.
BEGIN;
SET LOCAL lock_timeout = '5s';
ALTER TABLE "alerts" ADD COLUMN "page_delivered_at" TIMESTAMP(6);
COMMIT;
