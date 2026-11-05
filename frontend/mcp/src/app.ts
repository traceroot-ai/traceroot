import { createMcpHandler } from "@modelcontextprotocol/server";
import { createMcpHonoApp } from "@modelcontextprotocol/hono";
import type { Hono } from "hono";
import { createServer, type ServerConfig } from "./server.js";

export interface AppConfig extends ServerConfig {
  /** Hostnames the endpoint answers to (DNS-rebinding protection); unset allows any. */
  allowedHosts?: string[];
}

/**
 * The HTTP app: `POST /mcp` serves MCP over Streamable HTTP, `GET /health`
 * answers the container probe. Stateless, and the endpoint serves both the
 * 2026-07-28 and the earlier protocol (the handler's default).
 */
export function createApp(config: AppConfig): Hono {
  const app = createMcpHonoApp({ host: "0.0.0.0", allowedHosts: config.allowedHosts });
  const handler = createMcpHandler((ctx) => {
    const authorization = ctx.requestInfo?.headers.get("authorization") ?? "";
    return createServer(authorization, config);
  });

  app.get("/health", (c) => c.json({ status: "ok" }));
  app.all("/mcp", (c) => {
    // A missing credential is refused here; a wrong one is refused by the backend.
    if (!/^Bearer \S+/i.test(c.req.header("authorization") ?? "")) {
      return c.json({ error: "Missing bearer credential" }, 401, {
        "WWW-Authenticate": "Bearer",
      });
    }
    return handler.fetch(c.req.raw);
  });
  return app;
}
