import type { OAuthConfig } from "./oauth.js";

/**
 * Startup check that the issuer this server advertises is the one the
 * authorization server says it is. Assistants compare the two byte for byte
 * (the protected-resource metadata's `authorization_servers` entry against the
 * authorization server's `issuer`, and that against each token's `iss`), so
 * one stray slash or scheme makes every OAuth connection fail with nothing in
 * the logs. Checking it before serving turns that into a failed deploy.
 */

/** RFC 8414 §3: the well-known prefix goes between the issuer's host and its path. */
export function authorizationServerMetadataPath(issuer: string): string {
  const path = new URL(issuer).pathname.replace(/\/+$/, "");
  return `/.well-known/oauth-authorization-server${path}`;
}

/** A mismatch or a misconfigured authorization server; retrying will not help. */
export class IssuerConfigError extends Error {
  override name = "IssuerConfigError";
}

export interface IssuerCheckOptions {
  /**
   * Origin to reach the authorization server at from inside the deployment
   * (e.g. http://web:3000), when the public issuer URL is not reachable from
   * here. Unset fetches the issuer's own metadata URL.
   */
  internalOrigin?: string;
  fetchImpl?: typeof fetch;
  /** Tries while the authorization server is not up yet. */
  attempts?: number;
  delayMs?: number;
}

/**
 * Resolve when the authorization server's metadata names exactly
 * `config.authorizationServer` as its issuer. Throws IssuerConfigError at once
 * on a mismatch, a redirect (the metadata route is not served, usually because
 * OAuth is off on the web app) or a body that is not metadata, and a plain
 * Error once the server has not answered after every attempt.
 */
export async function verifyIssuer(
  config: OAuthConfig,
  options: IssuerCheckOptions = {},
): Promise<void> {
  const { fetchImpl = fetch, attempts = 30, delayMs = 2_000 } = options;
  const path = authorizationServerMetadataPath(config.authorizationServer);
  const url = new URL(path, options.internalOrigin ?? config.authorizationServer).toString();
  let lastFailure = "";
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    let response: Response;
    try {
      response = await fetchImpl(url, {
        redirect: "manual",
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(5_000),
      });
    } catch (error) {
      lastFailure = error instanceof Error ? error.message : String(error);
      if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, delayMs));
      continue;
    }
    if (response.status >= 300 && response.status < 400) {
      throw new IssuerConfigError(
        `${url} redirects (${response.status}) instead of serving authorization-server metadata; ` +
          "is MCP_RESOURCE_URL set on the web app?",
      );
    }
    if (!response.ok) {
      lastFailure = `HTTP ${response.status}`;
      if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, delayMs));
      continue;
    }
    const metadata = (await response.json().catch(() => null)) as { issuer?: unknown } | null;
    if (typeof metadata?.issuer !== "string") {
      throw new IssuerConfigError(`${url} returned no issuer`);
    }
    if (metadata.issuer !== config.authorizationServer) {
      throw new IssuerConfigError(
        `MCP_OAUTH_ISSUER is ${JSON.stringify(config.authorizationServer)} but the ` +
          `authorization server's issuer is ${JSON.stringify(metadata.issuer)}; they must match exactly`,
      );
    }
    return;
  }
  throw new Error(`${url} did not answer after ${attempts} attempts (${lastFailure})`);
}
