import { createMcpHandler } from "@modelcontextprotocol/server";
import { createMcpHonoApp } from "@modelcontextprotocol/hono";
import { Hono } from "hono";
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
  const hosts = (raw ?? "")
    .split(",")
    .map((host) => host.trim())
    .filter((host) => host !== "");
  return hosts.length > 0 ? hosts : undefined;
}

/**
 * The HTTP app: `POST /mcp` serves MCP over Streamable HTTP, `GET /health`
 * answers the container probe. Stateless, and the endpoint serves both the
 * 2026-07-28 and the earlier protocol (the handler's default).
 *
 * The credential check sits in an outer app so it runs before anything the
 * SDK's app does (Host validation, body parsing): an unauthenticated request
 * is refused with 401 whatever else is wrong with it. The probe is also
 * outside Host validation, since a probe reaches the pod by its own address.
 */
export function createApp(config: AppConfig): Hono {
  const mcp = createMcpHonoApp({ host: "0.0.0.0", allowedHosts: config.allowedHosts });
  const handler = createMcpHandler((ctx) => {
    const authorization = ctx.requestInfo?.headers.get("authorization") ?? "";
    return createServer(authorization, config);
  });
  mcp.all("/mcp", (c) => handler.fetch(c.req.raw));

  const app = new Hono();
  app.get("/health", (c) => c.json({ status: "ok" }));

  const { oauth } = config;
  if (oauth) {
    // Public metadata: assistants read it before they hold any credential, and a
    // browser-based client may read it cross-origin.
    app.get(resourceMetadataPath(oauth), (c) =>
      c.json(protectedResourceMetadata(oauth), 200, { "Access-Control-Allow-Origin": "*" }),
    );
  }

  app.all("/mcp", (c) => {
    const authorization = c.req.header("authorization") ?? "";
    const bearer = /^Bearer (\S+)/i.exec(authorization)?.[1];
    // A missing credential is refused here; a wrong one is refused by the backend.
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
    return mcp.fetch(c.req.raw);
  });
  return app;
}
