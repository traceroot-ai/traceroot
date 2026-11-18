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
