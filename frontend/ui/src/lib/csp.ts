// Content-Security-Policy for every page the app renders, built per request by
// proxy.ts. A fresh nonce lets Next.js mark its own inline scripts (the RSC
// payload and bootstrap) as trusted, and 'strict-dynamic' extends that trust to
// the chunks and SDK scripts those load, so script-src needs no host list.
//
// Styles stay 'unsafe-inline': React renders style attributes on the server and
// Radix injects <style> tags for scroll locking, and injected CSS cannot run
// code. style-src carries no nonce, because a nonce makes browsers ignore
// 'unsafe-inline'.

export const CSP_REPORT_PATH = "/api/csp-report";

export interface CspOptions {
  nonce: string;
  // Development adds 'unsafe-eval' (React rebuilds call stacks with eval) and
  // the HMR websocket.
  isDev?: boolean;
  // PostHog runs only when both are set (providers/posthog-provider.tsx).
  posthogKey?: string;
  posthogHost?: string;
  // Absolute when the REST API is on another origin, as in local development.
  apiUrl?: string;
}

export function buildContentSecurityPolicy({
  nonce,
  isDev = false,
  posthogKey,
  posthogHost,
  apiUrl,
}: CspOptions): string {
  const connectSrc = new Set([
    "'self'",
    // The sidebar's star count (components/layout/GitHubStarWidget.tsx).
    "https://api.github.com",
    ...(posthogKey && posthogHost ? posthogOrigins(posthogHost) : []),
    ...absoluteOrigin(apiUrl),
    ...(isDev ? ["ws:"] : []),
  ]);
  const directives = [
    ["default-src", "'self'"],
    [
      "script-src",
      "'self'",
      `'nonce-${nonce}'`,
      "'strict-dynamic'",
      ...(isDev ? ["'unsafe-eval'"] : []),
    ],
    ["style-src", "'self'", "'unsafe-inline'"],
    ["img-src", "'self'", "data:", "blob:"],
    ["font-src", "'self'"],
    ["connect-src", ...connectSrc],
    ["worker-src", "'self'", "blob:"],
    ["object-src", "'none'"],
    ["base-uri", "'self'"],
    ["form-action", "'self'"],
    ["frame-ancestors", "'none'"],
    ["report-uri", CSP_REPORT_PATH],
  ];
  return directives.map((directive) => directive.join(" ")).join("; ");
}

/**
 * The header that carries the policy. CSP_MODE=report-only reports violations
 * without blocking anything, for trying out a change to the policy.
 */
export function cspHeaderName(mode: string | undefined): string {
  return mode === "report-only" ? "Content-Security-Policy-Report-Only" : "Content-Security-Policy";
}

// posthog-js fetches its remote config and lazy scripts (session recording, web
// vitals) from an assets host: us-assets or eu-assets for PostHog Cloud, the
// same host behind a reverse proxy.
function posthogOrigins(host: string): string[] {
  const [origin] = absoluteOrigin(host);
  if (!origin) return [];
  const cloud = /^https:\/\/(us|eu)\.i\.posthog\.com$/.exec(origin);
  return cloud ? [origin, `https://${cloud[1]}-assets.i.posthog.com`] : [origin];
}

function absoluteOrigin(url: string | undefined): string[] {
  if (!url) return [];
  try {
    const { protocol, origin } = new URL(url);
    return protocol === "http:" || protocol === "https:" ? [origin] : [];
  } catch {
    // A relative URL such as /api/v1 is same-origin, which 'self' covers.
    return [];
  }
}
