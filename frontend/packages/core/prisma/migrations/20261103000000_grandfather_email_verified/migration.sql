BEGIN;
SET LOCAL lock_timeout = '5s';

-- Email/password sign-in now requires a verified address (when mail is
-- configured). Accounts created before that were never asked to verify, so
-- grandfather them rather than lock them out on their next sign-in. Sessions
-- are unaffected either way: only sign-in checks the flag.
--
-- @traceroot.ai addresses are left as they are. "Verified @traceroot.ai" is
-- what makes an account eligible for a staff role (api/support), so a
-- never-verified account on that domain must still prove the inbox; employees
-- get a fresh link on their next sign-in attempt.
UPDATE "users"
SET "email_verified" = true
WHERE "email_verified" = false
  AND lower("email") NOT LIKE '%@traceroot.ai';

COMMIT;
