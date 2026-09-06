/**
 * Human-friendly label for a session row's client, derived from its raw
 * user-agent string. The CLI sends a fixed `traceroot-cli/<version>`
 * user-agent on every request (unrelated to DEVICE_CLIENT_IDS, which only
 * labels the device-consent screen); everything else is a browser session
 * and gets a best-effort browser/OS summary instead of the raw string.
 */
export function formatSessionAgent(userAgent: string | null | undefined): string {
  if (!userAgent) {
    return "Unknown device";
  }

  if (userAgent.startsWith("traceroot-cli")) {
    return "TraceRoot CLI";
  }

  const browser = detectBrowser(userAgent);
  const os = detectOS(userAgent);

  if (browser && os) {
    return `${browser} on ${os}`;
  }
  // Fall back to whichever half we found, or the raw string as a last
  // resort so an unrecognized user-agent is still visible, not hidden.
  return browser ?? os ?? userAgent;
}

function detectBrowser(userAgent: string): string | null {
  // Order matters: Edge and Opera user-agents also contain "Chrome"/"Safari"
  // tokens for backward-compat with sites that sniff on those alone.
  if (/Edg\//.test(userAgent)) return "Edge";
  if (/OPR\//.test(userAgent) || /Opera/.test(userAgent)) return "Opera";
  if (/Chrome\//.test(userAgent)) return "Chrome";
  if (/Firefox\//.test(userAgent)) return "Firefox";
  if (/Safari\//.test(userAgent)) return "Safari";
  return null;
}

function detectOS(userAgent: string): string | null {
  // iOS devices identify as "like Mac OS X" for compatibility, so the
  // iPhone/iPad check must run before the plain Mac OS X one.
  if (/iPhone|iPad|iOS/.test(userAgent)) return "iOS";
  if (/Windows/.test(userAgent)) return "Windows";
  if (/Mac OS X/.test(userAgent)) return "macOS";
  if (/Android/.test(userAgent)) return "Android";
  if (/Linux/.test(userAgent)) return "Linux";
  return null;
}
