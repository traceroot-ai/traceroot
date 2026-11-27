import { safeCallbackUrl } from "@/lib/safe-callback-url";

/** Where a Slack connection made from workspace settings lands, and the fallback for any other. */
export function slackSettingsPath(workspaceId: string | undefined): string {
  return workspaceId ? `/workspaces/${workspaceId}/settings/integrations` : "/";
}

/**
 * Where Slack's authorization returns to: the page it was started from, when that
 * is a same-site path, or else the workspace's integration settings.
 */
export function slackReturnPath(workspaceId: string | undefined, returnTo: unknown): string {
  return safeCallbackUrl(
    typeof returnTo === "string" ? returnTo : null,
    slackSettingsPath(workspaceId),
  );
}

/**
 * The return path with the outcome added — `slack=connected`, or `slack=error`
 * and the reason — keeping the page's own query (the sign-up connect step's
 * project, say) and replacing an outcome left there by an earlier attempt.
 */
export function slackResultUrl(
  returnPath: string,
  outcome: { connected: true } | { connected: false; reason: string },
  base: string,
): URL {
  const url = new URL(returnPath, base);
  url.searchParams.delete("reason");
  url.searchParams.set("slack", outcome.connected ? "connected" : "error");
  if (!outcome.connected) url.searchParams.set("reason", outcome.reason);
  return url;
}
