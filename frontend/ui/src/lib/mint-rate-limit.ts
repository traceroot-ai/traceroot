// In-memory fixed-window rate limiter for the public JWT-mint endpoint
// (`/api/cli/token`). better-auth's own rate limiter only covers `/api/auth/*`,
// so this route needs its own bound. Per-instance memory is fine at the current
// single replica; the robust, cross-replica control — and reliable per-client
// keying that app-level XFF parsing can't guarantee behind the ALB — is a WAF
// rate rule at the edge, which is also the right layer to resolve the true
// client IP behind the load balancer.
//
// Minting requires a valid session (the route 401s otherwise), so the real
// concern this bounds is an unauthenticated flood forcing a session lookup per
// request — not credential minting itself.

type FixedWindow = { count: number; resetAt: number };

const windows = new Map<string, FixedWindow>();

// Hard cap on tracked buckets. A flood of distinct keys within one window
// expires nothing, so without an absolute bound the map would grow unbounded
// and every insert would run an ever-longer no-op sweep. Kept as a cap, not
// just a sweep trigger.
const MAX_WINDOWS = 10_000;

/**
 * Fixed-window rate check. Returns true if the request is allowed and records it.
 *
 * @param key - Bucket key (a client identifier).
 * @param max - Max requests permitted per window.
 * @param windowMs - Window length in milliseconds.
 * @param now - Current epoch ms (injectable for tests).
 * @returns True if allowed, false if the window is exhausted.
 */
export function checkMintRateLimit(
  key: string,
  max: number,
  windowMs: number,
  now: number = Date.now(),
): boolean {
  const existing = windows.get(key);
  if (existing && now < existing.resetAt) {
    if (existing.count >= max) {
      return false;
    }
    existing.count += 1;
    return true;
  }

  // New key, or its previous window has expired: (re)start a fresh window.
  windows.set(key, { count: 1, resetAt: now + windowMs });

  if (windows.size > MAX_WINDOWS) {
    // First reclaim naturally-expired windows (the common case).
    for (const [k, w] of windows) {
      if (now >= w.resetAt) windows.delete(k);
    }
    // A same-window flood of distinct keys expires nothing, so bound the map by
    // evicting the oldest entries (Map preserves insertion order). This can
    // reset a victim's counter early, but bounding memory + per-request work
    // under a flood matters more for this interim in-memory limiter.
    while (windows.size > MAX_WINDOWS) {
      const oldest = windows.keys().next().value;
      if (oldest === undefined) break;
      windows.delete(oldest);
    }
  }
  return true;
}

/**
 * Best-effort client identifier for rate limiting.
 *
 * Behind the internet-facing ALB the real client is the LAST `X-Forwarded-For`
 * entry — the ALB appends it, and a client can prepend fakes but can't remove
 * it, so (unlike the spoofable leftmost value) the last hop is trustworthy for
 * this topology. It is preferred over `x-real-ip`, which the ALB neither sets
 * nor strips: a client could forge `x-real-ip` to get a fresh bucket per
 * request and evade the limit. `x-real-ip` is only a fallback for topologies
 * (e.g. an nginx edge) where it is set and `x-forwarded-for` isn't. Falls back
 * to a shared bucket only when no forwarding header is present.
 */
export function rateLimitClientKey(headers: Headers): string {
  const forwardedFor = headers.get("x-forwarded-for");
  if (forwardedFor) {
    const hops = forwardedFor.split(",");
    const last = hops[hops.length - 1]!.trim();
    if (last) return last;
  }
  const realIp = headers.get("x-real-ip");
  if (realIp) {
    return realIp.trim();
  }
  return "local";
}

// Exposed for tests to reset shared state between cases.
export function __resetMintRateLimit(): void {
  windows.clear();
}

// Exposed for tests to assert the tracked-window bound holds under a flood.
export function __mintWindowCount(): number {
  return windows.size;
}
