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
