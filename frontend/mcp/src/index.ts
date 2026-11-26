import { serve } from "@hono/node-server";
import { createApp, parseAllowedHosts, parseVerificationTokens, parseListenPort } from "./app.js";
import { shouldServeAfterIssuerCheck } from "./issuer-check.js";
import { parseOAuthConfig } from "./oauth.js";
import { parseMaxResultChars } from "./server.js";
import { OtlpCallExporter, callRecorder, parseTelemetryConfig } from "./telemetry.js";

const MCP_SERVICE_URL = process.env.MCP_SERVICE_URL || "http://localhost:8200";
const PORT = parseListenPort(MCP_SERVICE_URL);

const oauth = parseOAuthConfig(process.env);

// With OAuth on, refuse to serve when the advertised issuer is not the
// authorization server's own: a mismatch fails every sign-in silently.
if (
  oauth &&
  !(await shouldServeAfterIssuerCheck(oauth, {
    internalOrigin: process.env.TRACEROOT_UI_URL || undefined,
  }))
) {
  process.exit(1);
}

// Every call logs a line to stdout; with MCP_TELEMETRY_OTLP_ENDPOINT set, it is
// also exported as a span.
const telemetry = parseTelemetryConfig(process.env);
const exporter = telemetry ? new OtlpCallExporter(telemetry) : undefined;
const recorder = callRecorder(exporter);

const app = createApp({
  backendUrl: process.env.BACKEND_INTERNAL_URL || "http://localhost:8000",
  timeoutMs: 60_000,
  allowedHosts: parseAllowedHosts(process.env.MCP_ALLOWED_HOSTS),
  oauth,
  maxResultChars: parseMaxResultChars(process.env.MCP_MAX_RESULT_CHARS),
  openaiAppsChallenge: process.env.MCP_OPENAI_APPS_CHALLENGE?.trim() || undefined,
  googleConnectedAppsTokens: parseVerificationTokens(process.env.MCP_GOOGLE_CONNECTED_APPS_TOKENS),
  recorder,
});

serve({ fetch: app.fetch, port: PORT });
console.log(
  `TraceRoot MCP server listening on :${PORT}` +
    (telemetry ? `; exporting tool-call spans to ${new URL(telemetry.endpoint).origin}` : ""),
);

// Send the spans still waiting before the container stops (at most 5 s).
if (exporter) {
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.once(signal, () => {
      void Promise.race([
        exporter.flush(),
        new Promise((resolve) => setTimeout(resolve, 5_000)),
      ]).then(() => process.exit(0));
    });
  }
}
