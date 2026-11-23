import type { CaptureResult } from "posthog-js";

/**
 * Query parameters that carry a secret and must never reach analytics: the
 * password reset link's `?token=` (whoever holds it can set the password until
 * it expires), and the same name wherever else a link carries one.
 */
const SECRET_PARAMS = ["token"];

function hasSecret(url: URL): boolean {
  return SECRET_PARAMS.some((name) => url.searchParams.has(name));
}

// Resolves a relative URL (`/auth/reset-password?token=…`) so its query can be read.
const RELATIVE_BASE = "http://relative.invalid";

/**
 * The value with any secret query parameter removed, if it is a URL that has
 * one: absolute, or relative to this site (a path or a bare query). A relative
 * URL stays relative.
 */
export function scrubUrl(value: unknown): unknown {
  // Only a value with a query can carry one. The query is parsed, not searched
  // as text, so an encoded name (`?%74oken=`) is read as the app reads it.
  if (typeof value !== "string" || !value.includes("?")) return value;
  const relative = value.startsWith("/") || value.startsWith("?");
  let url: URL;
  try {
    url = relative ? new URL(value, RELATIVE_BASE) : new URL(value);
  } catch {
    return value;
  }
  if (!hasSecret(url)) return value;
  for (const name of SECRET_PARAMS) url.searchParams.delete(name);
  if (value.startsWith("?")) return `${url.search}${url.hash}`;
  return relative ? `${url.pathname}${url.search}${url.hash}` : url.toString();
}

// Deep enough for any event's properties; deeper values are left alone.
const MAX_DEPTH = 20;

/** Scrubs every string in `value`, however deeply nested in objects and arrays. */
function scrubDeep(value: unknown, depth = 0): unknown {
  if (typeof value === "string") return scrubUrl(value);
  if (!value || typeof value !== "object" || depth > MAX_DEPTH) return value;
  const container = value as Record<string, unknown>;
  for (const key of Object.keys(container)) {
    const scrubbed = scrubDeep(container[key], depth + 1);
    if (scrubbed !== container[key]) container[key] = scrubbed;
  }
  return value;
}

/**
 * PostHog's `before_send`: every event, the explicit page views and the
 * automatic ones (page leave, clicks) alike, carries the page's URL in its
 * properties, and the person's first URL and referrer in `$set_once`. Secret
 * query parameters are removed from every URL in them, at any depth and
 * relative or absolute; the rest of each event is sent as it is.
 *
 * Session replay embeds the URL deep inside its snapshot data, so a replay
 * snapshot taken while the address bar holds a secret is not sent at all.
 */
export function scrubCaptureResult(
  result: CaptureResult | null,
  currentUrl: string = typeof window === "undefined" ? "" : window.location.href,
): CaptureResult | null {
  if (!result) return result;
  if (result.event === "$snapshot") {
    try {
      if (currentUrl && hasSecret(new URL(currentUrl))) return null;
    } catch {
      // Not a URL: nothing to judge by, so send as usual.
    }
  }
  scrubDeep(result.properties);
  scrubDeep(result.$set);
  scrubDeep(result.$set_once);
  return result;
}
