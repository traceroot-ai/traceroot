// `lastUseTime` is a coarse "last seen" indicator, and the validate-api-key route
// runs on the hot ingestion path — the Python backend (authenticate_api_key in
// backend/rest/routers/public/deps.py) validates the API key on every incoming
// trace request. Refreshing the timestamp on every successful validation amplifies
// writes against the same row under sustained traffic (and contends on its lock
// during ingestion bursts), so we debounce: only refresh when the stored value is
// missing or older than this interval.
//
// This lives in its own module rather than route.ts because Next.js route files
// may only export request handlers and route config — not arbitrary constants.
export const LAST_USE_TIME_REFRESH_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Whether a key's stored `lastUseTime` is stale enough to warrant a refresh write.
 * A missing timestamp (never used) is always considered stale.
 */
export function shouldRefreshLastUseTime(
  lastUse: Date | null | undefined,
  now: Date = new Date(),
): boolean {
  return !lastUse || now.getTime() - lastUse.getTime() >= LAST_USE_TIME_REFRESH_INTERVAL_MS;
}
