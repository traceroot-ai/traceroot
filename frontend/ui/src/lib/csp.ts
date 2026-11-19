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
// The name report-to reports under; REPORTING_ENDPOINTS points it at
// CSP_REPORT_PATH.
export const CSP_REPORT_ENDPOINT = "csp-endpoint";

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
  // NEXT_PUBLIC_APP_URL, which the auth client calls (lib/auth-client.ts). It
  // matches the page's own origin unless the app is reached by another name.
  appUrl?: string;
  // Whether the page is served over HTTPS, the only case in which the policy
  // also reports through report-to (see REPORTING_ENDPOINTS).
  https?: boolean;
}

export function buildContentSecurityPolicy({
  nonce,
  isDev = false,
  posthogKey,
  posthogHost,
  apiUrl,
  appUrl,
  https = false,
}: CspOptions): string {
  const connectSrc = new Set([
    "'self'",
    ...absoluteOrigin(appUrl),
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
    // The trace viewer plays audio from span I/O as data: URIs
    // (features/traces/components/inline-media.tsx).
    ["media-src", "'self'", "data:", "blob:"],
    ["font-src", "'self'"],
    ["connect-src", ...connectSrc],
    ["worker-src", "'self'", "blob:"],
    ["object-src", "'none'"],
    ["base-uri", "'self'"],
    ["form-action", "'self'"],
    ["frame-ancestors", "'none'"],
    ["report-uri", CSP_REPORT_PATH],
    ...(https ? [["report-to", CSP_REPORT_ENDPOINT]] : []),
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

/**
 * The Reporting-Endpoints header for report-to, sent with the policy on a page
 * served over HTTPS. A browser that supports report-to then sends its reports
 * there and ignores report-uri; the others, such as Firefox before 149, keep
 * using report-uri. A page served over plain HTTP gets neither report-to nor this
 * header: a browser registers the endpoint only on an HTTPS page (not even on
 * http://localhost), and with report-to it ignores report-uri, so it would send
 * no reports at all.
 */
export const REPORTING_ENDPOINTS = `${CSP_REPORT_ENDPOINT}="${CSP_REPORT_PATH}"`;

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
