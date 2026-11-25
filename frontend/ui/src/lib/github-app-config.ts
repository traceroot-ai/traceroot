import { safeCallbackUrl } from "@/lib/safe-callback-url";

/**
 * The GitHub App settings a connection needs before anyone is sent to GitHub:
 * the client id for the sign-in step and the app's name (its slug) for the
 * installation page. Without either, GitHub answers with an error page.
 *
 * Read from the process environment, as the Slack installer reads its own, so
 * that asking does not require the rest of the app's settings to be valid.
 */
export function missingGitHubAppSettings(): string[] {
  return ["GITHUB_APP_CLIENT_ID", "GITHUB_APP_NAME"].filter((name) => !process.env[name]?.trim());
}

/** Whether this deployment can connect GitHub at all. */
export function isGitHubAppAvailable(): boolean {
  return missingGitHubAppSettings().length === 0;
}

/**
 * Where a GitHub connection that cannot start goes instead of GitHub: back to
 * the page it started from (same-site only), with `github=unavailable`. The
 * missing settings are logged by name, never by value.
 */
export function githubUnavailableUrl(returnTo: string | null, base: string): URL {
  console.error(
    `[github] connect: not configured (${missingGitHubAppSettings().join(", ")} not set)`,
  );
  const url = new URL(safeCallbackUrl(returnTo, "/"), base);
  url.searchParams.set("github", "unavailable");
  return url;
}
