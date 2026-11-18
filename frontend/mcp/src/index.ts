import { serve } from "@hono/node-server";
import { createApp, parseAllowedHosts } from "./app.js";
import { parseOAuthConfig } from "./oauth.js";
import { parseMaxResultChars } from "./server.js";
import { OtlpCallExporter, callRecorder, parseTelemetryConfig } from "./telemetry.js";

const MCP_SERVICE_URL = process.env.MCP_SERVICE_URL || "http://localhost:8200";
const PORT = parseInt(new URL(MCP_SERVICE_URL).port || "8200", 10);

// Every call logs a line to stdout; with MCP_TELEMETRY_OTLP_ENDPOINT set, it is
// also exported as a span.
const telemetry = parseTelemetryConfig(process.env);
const exporter = telemetry ? new OtlpCallExporter(telemetry) : undefined;
const recorder = callRecorder(exporter);

const app = createApp({
  backendUrl: process.env.BACKEND_INTERNAL_URL || "http://localhost:8000",
  timeoutMs: 60_000,
  allowedHosts: parseAllowedHosts(process.env.MCP_ALLOWED_HOSTS),
  oauth: parseOAuthConfig(process.env),
  maxResultChars: parseMaxResultChars(process.env.MCP_MAX_RESULT_CHARS),
  openaiAppsChallenge: process.env.MCP_OPENAI_APPS_CHALLENGE?.trim() || undefined,
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
