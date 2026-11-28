# @traceroot/mcp

The hosted MCP server. It serves tools from the shared registry
(`@traceroot-ai/tools`) to any MCP client over Streamable HTTP, and forwards the
caller's credential to the public API, which validates it. It stores nothing and
holds no secret: it never reads `INTERNAL_API_SECRET`.

| File                   | Role                                                                                          |
| ---------------------- | --------------------------------------------------------------------------------------------- |
| `src/exposure.ts`      | Which registry tools are exposed (milestone 1: 24 reads), checked against the registry        |
| `src/server.ts`        | One `McpServer` per request, with tools built by `toMcpTool` and bound to the caller's bearer |
| `src/trace-content.ts` | A trace read defaults to the skeleton projection and withholds trace-level content            |
| `src/app.ts`           | Hono app: `/mcp` through the SDK's `createMcpHandler`, `/health`, a 401 for a missing bearer  |

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

| Variable               | Default                 | Meaning                                           |
| ---------------------- | ----------------------- | ------------------------------------------------- |
| `MCP_SERVICE_URL`      | `http://localhost:8200` | Its port is the listen port                       |
| `BACKEND_INTERNAL_URL` | `http://localhost:8000` | The public API (`rest`)                           |
| `MCP_ALLOWED_HOSTS`    | unset (any)             | Comma-separated hostnames the endpoint answers to |

## Parity check

`scripts/parity.ts` calls each of the 24 tools over MCP and compares the result
with a baseline: the pinned `traceroot-cli` (`--json`) for 20 tools, and a plain
HTTP request to the public API for the 4 the CLI has no command for
(`list_sessions`, `get_session`, `get_dashboard_data`, `run_widget_query`). The
mapping and the short allow-list of expected differences are in
`scripts/parity-cases.ts`; any other difference fails the run.

```sh
# Fast loop on fixtures (fake data; says the harness and service agree, not that the API does)
pnpm parity:mock

# Against a live stack
pnpm parity --url http://localhost:8200/mcp --key tr-… --host http://localhost:8000 \
  [--only get_trace] [--run-id <evaluation run id>]
```

`get_evaluation_run` has no list tool, so a live run needs `--run-id`; a call
with no seed data is reported as SKIP and the run exits non-zero.
