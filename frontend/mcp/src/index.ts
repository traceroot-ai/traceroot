import { serve } from "@hono/node-server";
import { createApp, parseAllowedHosts, parseVerificationTokens } from "./app.js";
import { IssuerConfigError, verifyIssuer } from "./issuer-check.js";
import { parseOAuthConfig } from "./oauth.js";
import { parseMaxResultChars } from "./server.js";

const MCP_SERVICE_URL = process.env.MCP_SERVICE_URL || "http://localhost:8200";
const PORT = parseInt(new URL(MCP_SERVICE_URL).port || "8200", 10);

const oauth = parseOAuthConfig(process.env);

// With OAuth on, refuse to serve until the advertised issuer is the
// authorization server's own: a mismatch fails every sign-in silently.
if (oauth) {
  try {
    await verifyIssuer(oauth, { internalOrigin: process.env.TRACEROOT_UI_URL || undefined });
  } catch (error) {
    const kind = error instanceof IssuerConfigError ? "misconfigured" : "unreachable";
    console.error(`OAuth issuer check failed (${kind}): ${(error as Error).message}`);
    process.exit(1);
  }
}

const app = createApp({
  backendUrl: process.env.BACKEND_INTERNAL_URL || "http://localhost:8000",
  timeoutMs: 60_000,
  allowedHosts: parseAllowedHosts(process.env.MCP_ALLOWED_HOSTS),
  oauth,
  maxResultChars: parseMaxResultChars(process.env.MCP_MAX_RESULT_CHARS),
  openaiAppsChallenge: process.env.MCP_OPENAI_APPS_CHALLENGE?.trim() || undefined,
  googleConnectedAppsTokens: parseVerificationTokens(process.env.MCP_GOOGLE_CONNECTED_APPS_TOKENS),
});

serve({ fetch: app.fetch, port: PORT });
console.log(`TraceRoot MCP server listening on :${PORT}`);
