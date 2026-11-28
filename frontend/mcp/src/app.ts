import { createMcpHandler } from "@modelcontextprotocol/server";
import { createMcpHonoApp } from "@modelcontextprotocol/hono";
import { Hono } from "hono";
import { CredentialCheck } from "./credential-check.js";
import {
  challenge,
  isExpiredJwt,
  protectedResourceMetadata,
  resourceMetadataPath,
  type OAuthConfig,
} from "./oauth.js";
import { createServer, type ServerConfig } from "./server.js";

export interface AppConfig extends ServerConfig {
  /** Hostnames the endpoint answers to (DNS-rebinding protection); unset allows any. */
  allowedHosts?: string[];
  /** When set, the endpoint advertises OAuth so assistants can sign in instead of using a key. */
  oauth?: OAuthConfig;
  /** How long the backend's verdict on a credential is reused. */
  credentialTtlMs?: number;
  /** Served at /.well-known/openai-apps-challenge to prove domain ownership; unset serves 404. */
  openaiAppsChallenge?: string;
  /**
   * Served as {"verification_tokens": [...]} at /.well-known/google-connected-apps
   * to prove domain ownership; unset serves 404.
   */
  googleConnectedAppsTokens?: string[];
}

/** Split a comma-separated list, dropping blanks; an empty result means unset. */
function parseList(raw: string | undefined): string[] | undefined {
  const items = (raw ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item !== "");
  return items.length > 0 ? items : undefined;
}

/**
 * The listen port named by a service URL. `URL.port` is empty both when the
 * URL names no port and when it names the scheme's default (`:80`, `:443`),
 * so read an explicit port from the authority; with none, fall back to 8200.
 */
export function parseListenPort(serviceUrl: string): number {
  const parsed = new URL(serviceUrl);
  if (parsed.port !== "") {
    return Number(parsed.port);
  }
  const authority = serviceUrl.split("//", 2)[1]?.split(/[/?#]/, 1)[0] ?? "";
  const explicit = /:(\d+)$/.exec(authority.slice(authority.lastIndexOf("@") + 1));
  return explicit ? Number(explicit[1]) : 8200;
}

/** Split a comma-separated host list, dropping blanks; an empty result means unset (any host). */
export function parseAllowedHosts(raw: string | undefined): string[] | undefined {
  return parseList(raw);
}

/** Split the comma-separated domain-verification tokens; an empty result means unset. */
export function parseVerificationTokens(raw: string | undefined): string[] | undefined {
  return parseList(raw);
}

/** Bearer token of an `Authorization` header, if it carries one. */
function bearerOf(authorization: string): string | undefined {
  return /^Bearer (\S+)/i.exec(authorization)?.[1];
}

/**
 * The HTTP app: `POST /mcp` serves MCP over Streamable HTTP, `GET /health`
 * answers the container probe. Stateless, and the endpoint serves both the
 * 2026-07-28 and the earlier protocol (the handler's default).
 *
 * The credential check sits in an outer app so it runs before anything the
 * SDK's app does (Host validation, body parsing): a request without a working
 * credential is refused with 401 whatever else is wrong with it. The probe is
 * also outside Host validation, since a probe reaches the pod by its own address.
 */
export function createApp(config: AppConfig): Hono {
  const credentials = new CredentialCheck({
    backendUrl: config.backendUrl,
    fetchImpl: config.fetchImpl,
    ttlMs: config.credentialTtlMs,
  });
  const mcp = createMcpHonoApp({ host: "0.0.0.0", allowedHosts: config.allowedHosts });
  const handler = createMcpHandler((ctx) => {
    const authorization = ctx.requestInfo?.headers.get("authorization") ?? "";
    const bearer = bearerOf(authorization);
    return createServer(authorization, config, {
      // A credential revoked since its check: the tool call already answered with
      // an error, and the next request gets the 401.
      onUnauthorized: bearer ? () => credentials.markInvalid(bearer) : undefined,
      userAgent: ctx.requestInfo?.headers.get("user-agent") ?? undefined,
    });
  });
  mcp.all("/mcp", (c) => handler.fetch(c.req.raw));

  const app = new Hono();
  app.get("/health", (c) => c.json({ status: "ok" }));

  // Domain verification for app directories, each in the form its directory
  // reads: a token as plain text, or a JSON list of tokens. Both are answered
  // directly (200, no redirect) and without a credential.
  const { openaiAppsChallenge, googleConnectedAppsTokens } = config;
  if (openaiAppsChallenge) {
    app.get("/.well-known/openai-apps-challenge", (c) =>
      c.body(openaiAppsChallenge, 200, { "Content-Type": "text/plain; charset=utf-8" }),
    );
  }
  if (googleConnectedAppsTokens?.length) {
    app.get("/.well-known/google-connected-apps", (c) =>
      c.json({ verification_tokens: googleConnectedAppsTokens }),
    );
  }

  const { oauth } = config;
  if (oauth) {
    // Public metadata: assistants read it before they hold any credential, and a
    // browser-based client may read it cross-origin.
    app.get(resourceMetadataPath(oauth), (c) =>
      c.json(protectedResourceMetadata(oauth), 200, { "Access-Control-Allow-Origin": "*" }),
    );
  }

  app.all("/mcp", async (c) => {
    const bearer = bearerOf(c.req.header("authorization") ?? "");
    if (!bearer) {
      return c.json({ error: "Missing bearer credential" }, 401, {
        "WWW-Authenticate": challenge(oauth),
      });
    }
    // An expired OAuth token gets the 401 that tells a client to refresh it.
    if (oauth && isExpiredJwt(bearer)) {
      return c.json({ error: "The access token expired" }, 401, {
        "WWW-Authenticate": challenge(oauth, {
          code: "invalid_token",
          description: "The access token expired",
        }),
      });
    }
    // A credential the backend refuses gets the 401 that sends a client back to
    // refresh or sign in. When the backend gives no answer (an outage), the
    // request goes on: the backend still checks every tool call, and an outage is
    // not a reason to make the user sign in again.
    const verdict = await credentials.check(bearer);
    if (verdict.status === "invalid") {
      return c.json({ error: verdict.detail }, 401, {
        "WWW-Authenticate": challenge(oauth, {
          code: "invalid_token",
          description: verdict.detail,
        }),
      });
    }
    return mcp.fetch(c.req.raw);
  });
  return app;
}
