# @traceroot/mcp

The hosted MCP server. It serves tools from the shared registry
(`@traceroot-ai/tools`) to any MCP client over Streamable HTTP, and forwards the
caller's credential to the public API, which validates it. It stores nothing and
holds no secret: it never reads `INTERNAL_API_SECRET`.

| File                      | Role                                                                                          |
| ------------------------- | --------------------------------------------------------------------------------------------- |
| `src/exposure.ts`         | Which registry tools are exposed (milestone 1: 24 reads), checked against the registry        |
| `src/server.ts`           | One `McpServer` per request, with tools built by `toMcpTool` and bound to the caller's bearer |
| `src/trace-content.ts`    | A trace read defaults to the skeleton projection and withholds trace-level content            |
| `src/redaction.ts`        | Every result has credentials redacted (by key name, URL parameter and value pattern)          |
| `src/telemetry.ts`        | One stdout line per tool call, and optionally one OTLP span per call                          |
| `src/app.ts`              | Hono app: `/mcp` through the SDK's `createMcpHandler`, `/health`, a 401 for a missing bearer  |
| `src/credential-check.ts` | Asks rest whether a bearer is accepted (cached ~30 s by hash) so a refused one gets a 401     |

The endpoint serves both the 2026-07-28 protocol and the earlier one.

## Run locally

```sh
pnpm --dir ../packages/tools build
BACKEND_INTERNAL_URL=http://localhost:8000 pnpm dev   # listens on :8200
```

Point an MCP client at it with a project API key:

```json
{ "url": "http://localhost:8200/mcp", "headers": { "Authorization": "Bearer tr-…" } }
```

Or drive it from the terminal:

```sh
MCP_URL=http://localhost:8200/mcp TRACEROOT_API_KEY=tr-… \
  pnpm exec vite-node scripts/smoke.ts get_trace '{"trace_id":"…"}'
```

| Variable                           | Default                 | Meaning                                                                                                                                     |
| ---------------------------------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `MCP_SERVICE_URL`                  | `http://localhost:8200` | Its port is the listen port                                                                                                                 |
| `BACKEND_INTERNAL_URL`             | `http://localhost:8000` | The public API (`rest`)                                                                                                                     |
| `MCP_ALLOWED_HOSTS`                | unset (any)             | Comma-separated hostnames the endpoint answers to                                                                                           |
| `MCP_MAX_RESULT_CHARS`             | `80000`                 | Longest tool result; a longer one is shrunk to fit as valid JSON (see below)                                                                |
| `MCP_OPENAI_APPS_CHALLENGE`        | unset (404)             | Token served as plain text at `/.well-known/openai-apps-challenge`, for OpenAI's domain verification                                        |
| `MCP_GOOGLE_CONNECTED_APPS_TOKENS` | unset (404)             | Comma-separated tokens served as `{"verification_tokens": [...]}` at `/.well-known/google-connected-apps`, for Google's domain verification |
| `MCP_TELEMETRY_OTLP_ENDPOINT`      | unset (off)             | OTLP/HTTP traces URL; set, each tool call is exported as a span (see below)                                                                 |
| `MCP_TELEMETRY_OTLP_HEADERS`       | unset                   | Export headers, `name=value` pairs separated by commas, values URL-encoded                                                                  |
| `MCP_TELEMETRY_SERVICE_NAME`       | `traceroot-mcp`         | `service.name` of the exported spans                                                                                                        |

## What a tool call returns

- **Arguments are checked by the tool**, not left to the SDK, so a bad call gets
  an `isError` result that names each bad path with the expected type or values,
  unknown keys with the likely intended one, and the accepted top-level shape.
  Arguments sent inside a single `arguments`, `params`, `input` or `args` object
  are unwrapped when the inner object is valid.
- **The result is JSON text, and the same object as `structuredContent`** when it
  is an object. No `outputSchema` is declared.
- **A result over `MCP_MAX_RESULT_CHARS` is shrunk, never cut mid-JSON**: strings
  over 10,000 characters end in `…[truncated N chars]`, then the largest lists
  lose their tails, counted in `_truncated` by path, until it fits. `_hint` says
  which arguments of that tool ask for less.
- **Credentials are redacted from every result**, whatever `fields` asked for:
  values under credential-like keys (`authorization`, `api_key`, `password`,
  `secret`, `token`, `cookie`, …; token counts such as `prompt_tokens` are kept),
  secret URL query parameters and passwords, and values that are credentials on
  their own (`Bearer …`, `sk-…`, private keys). The object that lost a value
  lists the keys in `_redactedKeys`. The rule is documented in `src/redaction.ts`.

## Telemetry

Every tool call logs one JSON line to stdout:
`{"event":"mcp_tool_call","tool":"get_trace","duration_ms":84,"is_error":false}`.
With `MCP_TELEMETRY_OTLP_ENDPOINT` set, each call is also exported, batched, as a
server span (`tools/call <tool>`) over OTLP/HTTP protobuf, with the tool name,
the client's name and version (from its handshake, or the User-Agent), duration,
outcome and error kind, backend status, result size, truncation, redaction
count, and whether the arguments were unwrapped. Argument values and result
content are never recorded. To send the spans to a TraceRoot project:

```sh
MCP_TELEMETRY_OTLP_ENDPOINT=https://<api origin>/api/v1/public/traces
MCP_TELEMETRY_OTLP_HEADERS="Authorization=Bearer%20tr-…"   # that project's API key
```

A failed export is logged with its status and dropped; it never affects a call.

## Parity check

`scripts/parity.ts` calls each of the 24 tools over MCP and compares the result
with a baseline: the pinned `traceroot-cli` (`--json`) for 20 tools, and a plain
HTTP request to the public API for the 4 the CLI has no command for
(`list_sessions`, `get_session`, `get_dashboard_data`, `run_widget_query`). The
mapping and the short allow-list of expected differences are in
`scripts/parity-cases.ts`; any other difference fails the run. The harness
compares the result text, and passes the baseline through the same credential
redaction the server applies, so redaction is the only other difference allowed.

```sh
# Fast loop on fixtures (fake data; says the harness and service agree, not that the API does)
pnpm parity:mock

# Against a live stack
pnpm parity --url http://localhost:8200/mcp --key tr-… --host http://localhost:8000 \
  [--only get_trace] [--run-id <evaluation run id>]
```

`get_evaluation_run` has no list tool, so a live run needs `--run-id`; a call
with no seed data is reported as SKIP and the run exits non-zero.

## Signing in with OAuth

By default the endpoint takes a project API key as a bearer. To let an assistant
(Claude, ChatGPT and others) connect with a sign-in instead, set on this service:

| Variable           | Value                                                                 |
| ------------------ | --------------------------------------------------------------------- |
| `MCP_RESOURCE_URL` | this endpoint's public URL, for example `https://mcp.example.com/mcp` |
| `MCP_OAUTH_ISSUER` | the web app's OAuth issuer, `BETTER_AUTH_URL` plus `/api/auth`        |

The web app needs the same `MCP_RESOURCE_URL`, and rest needs
`TRACEROOT_OAUTH_ISSUER` and `TRACEROOT_OAUTH_AUDIENCES` (see `docker-compose.prod.yml`).
With both set, an unauthenticated request is answered 401 with a pointer to
`/.well-known/oauth-protected-resource/mcp`, which names the sign-in server. The
server does not verify OAuth tokens itself: like a key, a token is forwarded to
rest, which checks the signature, the audience, the read scope, the project
chosen at consent, and that the connection has not been revoked. API keys keep
working.

Before a request reaches the SDK, the server asks rest about its bearer
(`GET /api/v1/public/sql/schema`, which takes every credential without a project)
and answers a refused one with `401` and `WWW-Authenticate: Bearer
error="invalid_token"`, which is what makes a client refresh or sign in again.
The verdict is cached for 30 seconds by a hash of the credential, so a revoked
connection is refused within that window; a tool call that rest answers 401 also
marks the credential refused at once. A credential rest accepts but refuses for
another reason (403, no access to the project) is let through, so the tool
results say why. If rest does not answer, the request is let through too: rest
still checks every tool call.
