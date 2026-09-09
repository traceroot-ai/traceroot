// Single source of truth for the better-auth session lifetime, shared by the
// better-auth config (auth.ts) and the CLI token-mint route, which slides the
// session's expiry by hand. bearer() is deliberately off, so better-auth's
// getSession/updateAge rolling refresh never fires on the mint path; the mint
// route replicates it against these same constants so the two can't drift.
//
// The session is a rolling idle-timeout window: it expires SESSION_EXPIRES_IN
// after its last refresh, and use refreshes it at most once per SESSION_UPDATE_AGE.
// A credential unused for the whole window must re-authenticate.
export const SESSION_EXPIRES_IN_SECONDS = 7 * 24 * 60 * 60; // 7 days of inactivity
export const SESSION_UPDATE_AGE_SECONDS = 24 * 60 * 60; // refresh at most once/day

// Disable better-auth's session "freshness" gate. better-auth defaults freshAge
// to 24h and requires the CURRENT session to be fresher than that for
// freshSessionMiddleware endpoints — including /list-sessions, which the Active
// Sessions page calls on load. Because the check is against the session's
// createdAt (NOT updatedAt), our sliding window doesn't help: a session created
// over a day ago, however actively used, gets a 403 and the whole revocation UI
// fails to load. We have no re-authenticate-for-sensitive-ops flow that needs
// freshness, so turn it off (0 = never require a fresh session). Note this also
// relaxes better-auth's freshness gate on `update-user` (non-password profile
// edits) — if a re-authenticate-for-sensitive-ops flow is ever added, this lever
// is what would need reinstating.
export const SESSION_FRESH_AGE_SECONDS = 0;
