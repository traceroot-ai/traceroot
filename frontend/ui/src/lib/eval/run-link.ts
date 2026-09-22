/**
 * The canonical dashboard link for an evaluation run.
 *
 * Extracted so the register response and the read response cannot describe the same run
 * with two different URLs. The route shape is the backend's to own — a client joining
 * `run_path` to its own `host_url` only resolves when the API and UI share an origin,
 * which is why both are returned and callers are told to print `run_url` verbatim.
 */

const DEFAULT_APP_BASE_URL = "http://localhost:3000";

/**
 * The control plane's public app origin, used to make the run link absolute so it
 * resolves regardless of how the API and UI origins are split (the SDK's host_url is the
 * API origin, which need not serve the UI). Mirrors the auth/slack conventions.
 *
 * Deliberately server configuration only: deriving the origin from the request's Host or
 * X-Forwarded-* headers would let the caller choose the link we hand back and the SDK
 * prints into CI logs.
 */
export function appBaseUrl(): string {
  const configured = process.env.NEXT_PUBLIC_APP_URL?.trim();
  if (!configured) return DEFAULT_APP_BASE_URL;
  try {
    const url = new URL(configured);
    // Only a web origin can host the dashboard. A value like `mailto:` parses as a URL but
    // cannot resolve a path against it, so it would fail every register and read.
    if (url.protocol === "http:" || url.protocol === "https:") return url.toString();
  } catch {
    // Not a URL at all: handled below, the same way.
  }
  // A misconfigured origin must not fail the request — the run itself is fine.
  console.error(
    `NEXT_PUBLIC_APP_URL is not an http(s) URL (${configured}); ` +
      `falling back to ${DEFAULT_APP_BASE_URL} for run links`,
  );
  return DEFAULT_APP_BASE_URL;
}

/** The run's UI-relative path + the absolute clickable URL for a client to print. */
export function runLink(projectId: string, runId: string): { run_path: string; run_url: string } {
  const run_path = `/projects/${projectId}/evaluations/${runId}`;
  return { run_path, run_url: new URL(run_path, appBaseUrl()).toString() };
}
