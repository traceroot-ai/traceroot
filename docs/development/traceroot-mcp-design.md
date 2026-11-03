# TraceRoot MCP server: design

Status: draft for review. This is a design only; no code has been written. It follows the decisions
already settled in the internal MCP design brief (D1–D7, Q3, Q4, Q12, Q14, Q16, Q17). It checks the
code claims those decisions rest on against current `main` and adds the pieces the brief leaves open:
resources, prompts, and source correlation.

## 1. Problem

TraceRoot data is reachable today from the web app, the in-app assistant, and the `traceroot` CLI.
A coding agent can use the CLI only when it has a shell, and only after a skill has taught it the
commands. Chat apps have no shell, so they cannot reach TraceRoot at all.

An MCP server lets any MCP client do three things:

- find TraceRoot's capabilities through typed tool schemas;
- call those tools with the user's own credential;
- answer questions such as "why did this request fail?", "did the last change regress the eval?" or
  "what were my slowest traces yesterday?" from live data.

When the client is a coding agent, it can then match the failure against the code it has open.

## 2. Use cases

| An agent wants to… | Tools (milestone 1 set) |
|---|---|
| See what failed recently | `list_findings`, `list_traces` (time window, `filters`), `get_finding` |
| Debug a trace the user pasted | `get_trace`, `get_finding_by_trace` |
| Find the code a failing span ran | `get_trace` returns `git_repo`, `git_ref` and per-span `git_source_file/line/function`; the agent then runs `git show` and `git log` locally (§4.5) |
| Answer an ad-hoc question over spans | `get_sql_schema`, `run_sql` |
| Check an eval run and its dataset | `get_evaluation_run`, `list_datasets`, `get_dataset`, `list_dataset_versions`, `get_dataset_version` |
| Read the dashboard or alert behind a page | `list_alerts`, `get_alert`, `get_dashboard_data`, `run_widget_query`, `get_widget_data` |
| Inspect detectors | `list_detectors`, `get_detector` (create and update wait for OAuth; see §4.3) |

## 3. What already exists

**The tool registry, `@traceroot-ai/tools`.** Its source is in this repo at
`frontend/packages/tools` and is also published to npm (currently 0.5.0). `traceroot-cli` only
consumes it. The package already describes itself as *"dispatched generically by the CLI, MCP, and
agent surfaces"*.

- **Source of truth.** The `x-tool` curation on each operation in `backend/rest/openapi/public.json`.
  `scripts/generate-registry.ts` turns it into `src/registry.generated.ts`.
- **`REGISTRY`.** 53 `RegistryEntry` items, each with `name`, `description`, `method`, `path`, a
  flat JSON-Schema `inputSchema`, `bodyParams` and `agentHiddenParams`. Every non-GET entry also has
  `policy {approvalClass, minRole, tenancy}`, which is validated at generation time
  (`validatePolicy`, `generate.ts:338`).
- **Engine.** `dispatch(entry, args, client)` fills the path, query and body generically.
  `ApiClient`, `ApiError` and `bearerAuth` handle HTTP. `stripOversizedNumericBounds` makes schemas
  safe for every model provider.
- **Per-surface adapter.** `toPiAgentTool` (`src/pi.ts`, 157 lines) adapts entries for the in-app
  assistant. It hides `fixedArgs` and `agentHiddenParams`, applies defaults and renders results.
  **The MCP adapter will copy this pattern.**

**The two existing consumers.**

| Surface | How it uses the registry |
|---|---|
| `traceroot-cli` (separate repo) | `src/registry/factory.ts` generates commands from `REGISTRY`. `naming.ts` is an exhaustive placement map, and a parity test fails when a tool is left unplaced. `execute.ts` forwards a bearer token through `dispatch`. |
| In-app assistant (`frontend/ee/agent`) | `tools/registry-tools.ts` binds 21 curated reads to internal routes. `write-policy.ts` enforces `approvalClass` before each call. |

**Public API auth.** `backend/rest/routers/public/deps.py` defines three credential checks:

- `DualStampedAuth` covers every project-scoped read, including the `run_sql` and `run_widget_query`
  POSTs. It accepts a project API key or a user token.
- `AccountStampedAuth` covers every write router and the account reads. It rejects an API key with
  403, *"this operation requires a user login"* (`deps.py:929-934`).

As a result, an API-key MCP server is read-only by construction.

**SDKs (`traceroot-py`, `traceroot-ts`).** The SDKs only ingest data. They record git context: repo
and ref on the trace, and file, line and function on each span. The public trace read returns those
fields (`routers/public/serialize.py`, `services/trace_reader.py`). The MCP server does not reuse any
SDK code, but it depends on this data.

## 4. Design

### 4.1 Architecture

```
MCP client ──Streamable HTTP, Bearer <key|token>──▶ mcp  (new: frontend/mcp, Hono + official MCP SDK v2)
                                                     │  exposure map (24 tools)  ← copies CLI naming.ts
                                                     │  toMcpTool()              ← new, beside pi.ts in @traceroot-ai/tools
                                                     │  dispatch() + ApiClient   ← reused unchanged
                                                     ▼
                                       rest: /api/v1/public/*   (validates the forwarded credential; unchanged)
```

- **A hosted program of its own** (D2, D5, Q12). It runs as its own container at `frontend/mcp`,
  next to `ui`, `worker` and `ee/agent`. It is not a Next.js route, not part of the Python backend,
  and not under `ee/`. It is a workspace package, so it imports the registry from source and there
  is no npm version to pin (Q5).
- **Stateless and small.** It has no database and no login code. It forwards the caller's
  credential, and `rest` checks it, as it already does for the CLI. It must never be given
  `INTERNAL_API_SECRET`. Its only configuration is the backend URL.
- **Built on the official SDK, v2 line** (D7, Q16). It uses `@modelcontextprotocol/server` with
  the official Hono adapter. `createMcpHandler(factory)` builds one server and one transport per
  request. The default `legacy: "stateless"` mode answers clients on both the pre-2026-07-28 and the
  2026-07-28 protocol at one endpoint.
- **Option considered and rejected: a local `traceroot mcp` stdio subcommand in the CLI.** It would
  reuse the CLI's login and token refresh directly. It is rejected because D2 makes the server
  hosted-only, and chat apps cannot launch local programs. Terminal users already have the CLI, and
  coding agents with a shell are better served by it plus the `traceroot-cli` skill.

### 4.2 How the registry is reused

The rule is the same one the CLI and the in-app assistant follow: **each surface decides which tools
it exposes and how results are shaped; it never redefines a tool.**

| Piece | Reused as-is | Changed | New |
|---|---|---|---|
| Names, descriptions, input schemas, policy | `REGISTRY` (generated from `public.json`) | | |
| Request building and HTTP | `dispatch`, `ApiClient`, `bearerAuth`, `ApiError` | | |
| Schema hygiene | `stripOversizedNumericBounds` | | |
| Tool annotations | | `generate.ts` derives `title`, `readOnlyHint`, `destructiveHint` and `openWorldHint: false` into a new typed `RegistryEntry` field, validated like `policy`. Every surface gets the same hints, and no tool can ship without them. | |
| MCP tool shape | | | `src/mcp.ts` in `@traceroot-ai/tools`. It mirrors `pi.ts` and is matched structurally, with no dependency on the MCP SDK. It turns an entry into a `registerTool` config plus a handler, drops `agentHiddenParams` and fixed args, applies defaults (Q4), and returns errors as `isError` results with the backend's `detail`. It does not inject the `label` param that `pi.ts` adds. |
| Exposure | Pattern from CLI `naming.ts` and its parity test | | `frontend/mcp/src/exposure.ts`. Every exposed name must be a live registry tool, and every one must be a GET or the SQL pair until writes land. |
| Server and transport | | | `frontend/mcp/src/index.ts`: Hono, `createMcpHandler`, a health route, and the incoming `Authorization` header passed as `bearerAuth` into `ApiClient`. |
| Backend | All `/api/v1/public/*` routes and their auth | | **Nothing for milestone 1.** OAuth changes are in §5. |

What the CLI has that is **not** reused: the device-flow login, the credential file, the token
minting in `execute.ts`, and the terminal enhancers. A hosted server receives credentials from the
client and has no local state, so none of that applies. Error text in the CLI's `translate()` names
CLI flags. The MCP adapter passes the backend `detail` through instead.

### 4.3 Tools

**Milestone 1 exposes 24 read tools (Q3).** That is the in-app assistant's 21 curated reads, plus
`get_trace` and the SQL pair:

`list_traces`, `get_trace`, `list_sessions`, `get_session`, `list_findings`, `get_finding`,
`get_finding_by_trace`, `list_detectors`, `get_detector`, `list_alerts`, `get_alert`,
`list_dashboards`, `get_dashboard`, `get_dashboard_data`, `run_widget_query`, `get_widget`,
`get_widget_data`, `get_evaluation_run`, `list_datasets`, `get_dataset`, `list_dataset_versions`,
`get_dataset_version`, `get_sql_schema`, `run_sql`.

- **Input and output shapes are the registry's own.** For example, `get_trace` takes
  `{trace_id, fields?}` and returns the public trace JSON with its span tree and git fields.
  `run_sql` takes `{query, parameters?, max_rows?}` and returns rows. `project_id` is hidden,
  because an API key already fixes the project.
- **Trace content is withheld by default (Q4).** The skeleton projection still returns the trace's
  own input, output and metadata. The adapter strips them unless the caller asks for them. This is
  one more curated, validated registry field, not logic specific to MCP.
- **Every tool is listed, with no server-side search tool (Q14).** 24 is under every published
  limit, and clients that defer tool loading do it themselves. Before shipping, measure the tokens
  the tool list costs. Let `run_sql` absorb the next request instead of adding a 25th tool.
- **Left out:** `export_trace` (it exists to write files), `whoami`, `list_projects` and
  `list_workspaces` (the key fixes the project, and the account reads reject keys anyway),
  `list_trace_filter_values`, `list_evaluations` and `list_evaluation_runs` (they follow when the
  assistant binds them), and all write tools.
- **Writes arrive with OAuth (milestone 2).** Each write honours its `approvalClass`. `none` runs
  directly. `confirm` and `approval` ask for the user's yes through MCP elicitation. They are never
  silently treated as `none`. This is the same contract `write-policy.ts` enforces for the in-app
  assistant.

### 4.4 Resources and prompts (proposed; after milestone 1)

Milestone 1 ships tools only, because tools are the one primitive every target client supports.
Both additions below go through the same adapter and `dispatch`, so neither adds a tool definition.

- **Resources.** Read-only URI templates mapped to registry GETs, for clients that attach context
  instead of calling tools: `traceroot://traces/{trace_id}` → `get_trace` (with the Q4 default),
  `traceroot://findings/{finding_id}` → `get_finding`,
  `traceroot://evaluation-runs/{run_id}` → `get_evaluation_run`, and `traceroot://sql/schema` →
  `get_sql_schema`.
- **Prompts.** Short templates that only orchestrate the tools:
  - `debug_trace(trace_id)`: read the trace and its finding, then map the failing span's
    `git_ref` and file and line to local code.
  - `triage_findings(range?)`: summarise recent findings by detector.
  - `eval_run_summary(run_id)`: summarise one run's scores per scorer.

  The wording comes from the existing `traceroot-skills` content, so the CLI skill and the MCP
  prompts describe the same workflows.

### 4.5 Source code and GitHub correlation

No new tool or endpoint is needed. `get_trace` already returns `git_repo`, `git_ref` and, for each
span, `git_source_file/line/function`, as recorded by the SDKs. A coding agent usually has the
repository checked out, so it can run `git show <ref>:<file>` and `git log <ref>..HEAD` itself.

The in-app assistant's GitHub tools (`check_github_access`, `git_clone`, PR creation) depend on its
sandbox, the GitHub App installation token, and internal service auth, so they stay out of MCP. If
a chat-app user later needs commit or PR history, that needs a new public endpoint with its own
registry curation. It should not be a tool hand-written for MCP.

## 5. Auth and transport

**Transport.** Streamable HTTP only, hosted, stateless. There is no local stdio build (D2) and no
deprecated SSE-only transport.

**Milestone 1: pasted API key** (D4). The client sends `Authorization: Bearer tr-…` and the server
forwards it unchanged. `rest` validates the key and scopes the request to the key's project. A bad
key is refused by the API, not by the MCP server. The endpoint serves both protocol versions (Q17).

```json
{ "url": "https://<traceroot-host>/mcp", "headers": { "Authorization": "Bearer tr-…" } }
```

**Milestone 2: OAuth** (D4, Q7). This is the only way to reach chat apps and app directories.

- **Authorization server.** The web app (`frontend/ui`), using better-auth's MCP / OAuth provider
  plugin. Signing keys, `/api/auth/jwks` and the sign-in pages carry over.
- **New work:**
  - a consent page, adapted from the CLI device-approval page;
  - a permission-scope model, which does not exist anywhere today and is the critical path:
    `offline_access`, `openid`, `email`, plus one read scope;
  - one more token branch in `deps.py`;
  - project selection for signed-in users;
  - the better-auth upgrade and its migration.
- **Protocol versions.** The plugin requires `legacy: "reject"`, so the OAuth endpoint speaks only
  the 2026-07-28 protocol (Q17).

**Cloud vs. self-hosted.** It is the same container in both. Self-hosters get it as one more compose
service, free and optional (D3). Where it runs in TraceRoot Cloud, and on which hostname, is Q15.
The brief proposes starting from a `/mcp` path on the existing app host, so the MCP endpoint shares
an origin with sign-in.

## 6. Location and distribution

- `frontend/packages/tools/src/mcp.ts`: the adapter, exported from `src/index.ts`. Annotation
  derivation goes in `src/generate.ts` and `src/types.ts`. The next tools release also publishes it
  to npm through `publish-tools.yml`, so other surfaces can use it.
- `frontend/mcp/`: the program (`package.json`, `src/index.ts`, `src/exposure.ts`), plus one line in
  `frontend/pnpm-workspace.yaml`.
- `docker/Dockerfile.mcp`, trimmed from `Dockerfile.agent`, plus a service in
  `docker-compose.prod.yml` and CI matrix entries. Cloud deployment needs changes in the
  infrastructure repos (Q15).
- **Nothing is published to npm or pip.** Users add a URL and a credential to their MCP client.
  `traceroot setup` already detects local agents (`traceroot-cli/src/agents/`), so it could later
  write that config. A `docs/cli/mcp.mdx` page would hold the client snippets.

## 7. Lessons from reference servers

The brief compares seven open-source MCP servers from observability and analytics products, read
from their source. Its source list points to local checkouts under `~/Desktop/code/reference/`. That
directory is not on this machine, so these points come from the brief's summary. Patterns that shape
this design:

- **Hosted is the norm.** The servers that run as separate services each use their own hostname. API
  keys are the baseline login, and OAuth is the upgrade that unlocks chat apps.
- **Everyone building in TypeScript uses the official SDK directly.** None of them uses a wrapper
  framework.
- **Annotations are generated and enforced, not hand-written.** The stricter servers fail CI when a
  tool is missing them. That is why annotations belong in our generator, not in `frontend/mcp`.
- **Large catalogs hide behind a search or execute tool.** That only pays off at several times our
  24 tools. The general lessons still apply: descriptions are the search index, names stay short,
  and a CI token count keeps growth visible.
- **Per-user tool groups that can be switched on and off do not survive a stateless server.** One
  server dropped them when it went stateless, and the 2026-07-28 protocol removes sessions.
- **Coding agents are pointed at the CLI where a shell exists.** MCP is for hosts without one, which
  is why OAuth is what makes the project worth building (D4).
- **Real write gates are rare.** Most servers rely on hints the client may ignore. Using elicitation
  for `confirm` and `approval` is a deliberate step past that.

## 8. Milestone 1 as pull requests

| PR | What | Copies |
|---|---|---|
| 1 | Annotations in `generate.ts` / `types.ts`; regenerated registry | `validatePolicy` |
| 2 | `toMcpTool` adapter, including the Q4 trace-content default | `src/pi.ts` |
| 3 | `frontend/mcp`: Hono + `createMcpHandler`, `exposure.ts` for the 24 tools, parity check | CLI `naming.ts`; `ee/agent` Hono bootstrap |
| 4 | `Dockerfile.mcp`, compose service, CI entries | `Dockerfile.agent` |

**Done when** a pasted API key, used from a local coding agent and the MCP Inspector against local
compose, meets all of these:

- it lists the 24 tools, each with its annotations;
- a real question is answered from live data;
- each tool returns what the CLI returns for the same call;
- a bad key is refused by `rest`;
- a trace read withholds its content unless asked.

## 9. Open questions and risks

1. **Q15: where it runs in Cloud, on which hostname, and who is on call.** This sits in the
   infrastructure repos. Start the conversation during milestone 1; milestone 1 does not wait on it.
2. **Q7: OAuth spike.** The token's real claims, whether the better-auth migration is clean, whether
   the consent page can be shared safely, and whether a chat app completes the flow. The
   permission-scope model gates all of this.
3. **Key scope.** An `ingest`-scope key can read every trace in its project. Recommend a dedicated
   key for MCP in the docs, or add a read-only key scope?
4. **Result size and shape.** The in-app assistant's formatters and truncation live under `ee/` and
   cannot be imported. Ship JSON with a size cap first, and revisit only if token cost becomes a
   problem.
5. **Resources and prompts (§4.4).** Confirm they are worth adding after milestone 1, and whether
   prompt text should be generated from `traceroot-skills` so it stays in sync with the skills.
6. **Q10: self-host wording.** Rate limiting is off on self-host, so "no rate limit" is accurate and
   "highest ceiling" is not.
7. **Reference sources.** The local `~/Desktop/code/reference/` checkouts were not available to this
   review. §7 relies on the brief's source-cited summary, refreshed on 2026-10-16.
