import { serve } from "@hono/node-server";
import { createApp, parseAllowedHosts, parseListenPort } from "./app.js";

const MCP_SERVICE_URL = process.env.MCP_SERVICE_URL || "http://localhost:8200";
const PORT = parseListenPort(MCP_SERVICE_URL);

const app = createApp({
  backendUrl: process.env.BACKEND_INTERNAL_URL || "http://localhost:8000",
  timeoutMs: 60_000,
  allowedHosts: parseAllowedHosts(process.env.MCP_ALLOWED_HOSTS),
});

serve({ fetch: app.fetch, port: PORT });
console.log(`TraceRoot MCP server listening on :${PORT}`);
