import { createMcpHandler } from "@modelcontextprotocol/server";
import { createMcpHonoApp } from "@modelcontextprotocol/hono";
import { Hono } from "hono";
import { createServer, type ServerConfig } from "./server.js";

export interface AppConfig extends ServerConfig {
  /** Hostnames the endpoint answers to (DNS-rebinding protection); unset allows any. */
  allowedHosts?: string[];
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
  app.all("/mcp", (c) => {
    // A missing credential is refused here; a wrong one is refused by the backend.
    if (!/^Bearer \S+/i.test(c.req.header("authorization") ?? "")) {
      return c.json({ error: "Missing bearer credential" }, 401, {
        "WWW-Authenticate": "Bearer",
      });
    }
    return mcp.fetch(c.req.raw);
  });
  return app;
}
