const FALLBACK_REDIRECT_PATH = "/";
const CONTROL_CHAR_PATTERN = /[\u0000-\u001F\u007F]/;

/**
 * Keep post-auth redirects on the current origin.
 *
 * Accept only path-absolute URLs like "/projects/123?tab=settings".
 * Reject absolute, protocol-relative, malformed, and control-character inputs.
 */
export function sanitizeRedirectPath(value: string | null | undefined): string {
  if (!value) return FALLBACK_REDIRECT_PATH;

  if (
    !value.startsWith("/") ||
    value.startsWith("//") ||
    value.startsWith("/\\") ||
    CONTROL_CHAR_PATTERN.test(value)
  ) {
    return FALLBACK_REDIRECT_PATH;
  }

  return value;
}
