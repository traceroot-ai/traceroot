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
  if (!existing || now >= existing.resetAt) {
    windows.set(key, { count: 1, resetAt: now + windowMs });
    if (windows.size > 10_000) {
      for (const [k, w] of windows) {
        if (now >= w.resetAt) windows.delete(k);
      }
    }
    return true;
  }
  if (existing.count >= max) {
    return false;
  }
  existing.count += 1;
  return true;
}

/**
 * Best-effort client identifier for rate limiting.
 *
 * Behind the internet-facing ALB the real client is the LAST `X-Forwarded-For`
 * entry — the ALB appends it, and a client can prepend fakes but can't remove
 * it, so (unlike the spoofable leftmost value) the last hop is trustworthy for
 * this topology. `x-real-ip` wins when the edge sets it. Falls back to a shared
 * bucket only when no forwarding header is present (e.g. direct/local requests).
 */
export function rateLimitClientKey(headers: Headers): string {
  const realIp = headers.get("x-real-ip");
  if (realIp) {
    return realIp.trim();
  }
  const forwardedFor = headers.get("x-forwarded-for");
  if (forwardedFor) {
    const hops = forwardedFor.split(",");
    return hops[hops.length - 1]!.trim();
  }
  return "local";
}

// Exposed for tests to reset shared state between cases.
export function __resetMintRateLimit(): void {
  windows.clear();
}
