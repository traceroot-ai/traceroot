// The sign-in page redirects to `callbackUrl` after login. The value is
// attacker-suppliable (it arrives in the query string of a link that renders
// our real sign-in page), so an unvalidated redirect is an open redirect:
// a phishing link can bounce a freshly-authenticated user to a foreign site.
// Only same-origin destinations may pass; everything else falls back.

const BASE = "http://same-origin.invalid";

/**
 * Validate a post-login redirect target as same-origin.
 *
 * Parses with the WHATWG URL parser against a sentinel base, so the known
 * smuggling shapes are rejected by spec-compliant parsing rather than by
 * pattern-matching: absolute URLs keep their own origin, protocol-relative
 * `//host` and backslash variants (`/\host` — browsers treat the backslash
 * as a slash) resolve to a foreign authority, and non-HTTP schemes
 * (`javascript:`, `data:`) have no matching origin at all.
 *
 * Returns the normalized path (+ query + hash) for same-origin values, the
 * fallback for everything else.
 */
export function safeCallbackUrl(raw: string | null | undefined, fallback = "/"): string {
  if (!raw) {
    return fallback;
  }
  let url: URL;
  try {
    url = new URL(raw, BASE);
  } catch {
    return fallback;
  }
  if (url.origin !== BASE) {
    return fallback;
  }
  const target = url.pathname + url.search + url.hash;
  // Same-origin parse is not enough: dot-segment normalization can collapse a
  // leading `/..` and leave a protocol-relative path (`/..//host` -> `//host`),
  // which re-parses cross-origin at the redirect site. A legitimate target is
  // always a single-slash absolute path, so require exactly that.
  if (!target.startsWith("/") || target.startsWith("//")) {
    return fallback;
  }
  return target;
}
