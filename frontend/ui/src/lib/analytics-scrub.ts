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

/** The value with any secret query parameter removed, if it is a URL that has one. */
export function scrubUrl(value: unknown): unknown {
  if (typeof value !== "string" || !value.includes("?")) return value;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return value;
  }
  if (!hasSecret(url)) return value;
  for (const name of SECRET_PARAMS) url.searchParams.delete(name);
  return url.toString();
}

function scrubProperties(properties: Record<string, unknown> | undefined): void {
  if (!properties) return;
  for (const [key, value] of Object.entries(properties)) {
    const scrubbed = scrubUrl(value);
    if (scrubbed !== value) properties[key] = scrubbed;
  }
}

/**
 * PostHog's `before_send`: every event, the explicit page views and the
 * automatic ones (page leave, clicks) alike, carries the page's URL in its
 * properties, and the person's first URL and referrer in `$set_once`. Secret
 * query parameters are removed from all of them; the rest of each event is
 * sent as it is.
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
  scrubProperties(result.properties);
  scrubProperties(result.$set as Record<string, unknown> | undefined);
  scrubProperties(result.$set_once as Record<string, unknown> | undefined);
  return result;
}
