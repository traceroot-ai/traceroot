import { serve } from "@hono/node-server";
import { createApp, parseAllowedHosts } from "./app.js";

const MCP_SERVICE_URL = process.env.MCP_SERVICE_URL || "http://localhost:8200";
const PORT = parseInt(new URL(MCP_SERVICE_URL).port || "8200", 10);

const app = createApp({
  backendUrl: process.env.BACKEND_INTERNAL_URL || "http://localhost:8000",
  timeoutMs: 60_000,
  allowedHosts: parseAllowedHosts(process.env.MCP_ALLOWED_HOSTS),
});

serve({ fetch: app.fetch, port: PORT });
console.log(`TraceRoot MCP server listening on :${PORT}`);
