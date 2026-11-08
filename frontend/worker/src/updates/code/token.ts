/**
 * How a scheduled run gets a short-lived installation token for a repository.
 *
 * It asks the app's token route over its internal path (the internal secret
 * and the workspace id, no user session), which picks the installation whose
 * account owns the repository and mints a token that lasts about an hour. The
 * token is held in memory for this run, passed only to the clone sandbox, and
 * never logged. The worker does not hold the app's private key.
 */

export interface TokenRouteConfig {
  appBaseUrl: string;
  internalSecret: string;
  fetchImpl?: (
    url: string,
    init: { headers: Record<string, string>; signal?: AbortSignal },
  ) => Promise<Response>;
}

export function internalTokenProvider(config: TokenRouteConfig) {
  return async (repo: string, workspaceId: string): Promise<string> => {
    const doFetch = config.fetchImpl ?? ((u, init) => fetch(u, init));
    const url = new URL("/api/github/token", config.appBaseUrl);
    url.searchParams.set("repo", repo);
    const response = await doFetch(url.toString(), {
      headers: { "X-Internal-Secret": config.internalSecret, "x-workspace-id": workspaceId },
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(`The token route answered ${response.status}.`);
    const body = (await response.json()) as { token?: unknown };
    if (typeof body.token !== "string" || body.token === "")
      throw new Error("The token route returned no token.");
    return body.token;
  };
}
