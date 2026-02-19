# TraceRoot AI Assistant — MVP Design

**Date:** 2026-02-19
**Status:** Approved
**Branch:** pivot/agentops

## Overview

Embedded AI debugging assistant in the TraceRoot observability UI. Users click a button, open a chat panel, and ask the AI to analyze their telemetry data. The agent can query ClickHouse via existing FastAPI endpoints, download traces into a sandbox workspace for deep analysis, and stream its work back to the UI in real time.

## Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Agent language | TypeScript | Pi-mono ecosystem, reference code, frontend team ownership |
| Agent framework | `@mariozechner/pi-agent-core` + `@mariozechner/pi-ai` | Model-agnostic, battle-tested agent loop, multi-provider LLM |
| Architecture pattern | Mom (agent outside sandbox) | Backend = brain, sandbox = hands. Direct API access, smaller images |
| Sandbox (prod) | Daytona | ~27-90ms cold start, built-in git, unlimited sessions |
| Sandbox (dev) | Docker container | No Daytona dependency for local dev |
| Streaming | SSE | Unidirectional, simpler than WebSocket, works through proxies |
| Session storage | PostgreSQL (Prisma) | Server-side, existing infra, no IndexedDB |
| Frontend | Custom React (web-ui as reference only) | Deep TraceRoot integration needed (auth, layout, server-side sessions) |
| ClickHouse access | Agent calls existing FastAPI endpoints via bash/curl | No custom tools — system prompt provides API docs + schemas |
| Skills | Deferred | System prompt is enough for MVP. Add skill files later if needed |
| GitHub App | Deferred | Follow-up work. Not in MVP scope |

## Architecture

```
FRONTEND (Next.js)
┌─────────────────────────────────────────────────────────┐
│  AI Chat Panel (custom React)                           │
│  - Streams agent output (text + tool execution)         │
│  - Context-aware (project/trace/session from URL)       │
│  - Session list (past conversations)                    │
└─────────────────────┬───────────────────────────────────┘
                      │ SSE + REST
┌─────────────────────┴───────────────────────────────────┐
│  Next.js API Routes (proxy)                             │
│  - Auth check (NextAuth session)                        │
│  - Forward to agent service                             │
└─────────────────────┬───────────────────────────────────┘
                      │ Internal HTTP

AGENT SERVICE (separate TS process)
┌─────────────────────┴───────────────────────────────────┐
│  Agent Runner (Mom pattern)                             │
│  - @mariozechner/pi-agent-core (agent loop)             │
│  - @mariozechner/pi-ai (multi-provider LLM)             │
│  - Standard tools: bash, read, write, edit              │
│  - SSE bridge: agent events → HTTP stream               │
│  - Session persistence (Prisma/PostgreSQL)              │
├─────────────────────────────────────────────────────────┤
│  Executor (swappable)                                   │
│  - DockerExecutor (dev) / DaytonaExecutor (prod)        │
│  - exec(), workspace setup, lifecycle management        │
└───────────────────────┬─────────────────────────────────┘
                        │
            ┌───────────┴───────────┐
            │  Sandbox              │
            │  /workspace/          │
            │  ├── traces/          │
            │  └── notes/           │
            └───────────────────────┘
                        │ Agent calls existing APIs
            ┌───────────┴───────────┐
            │  FastAPI Backend      │
            │  /api/v1/traces       │
            │  /api/v1/internal/    │
            │  (no changes needed)  │
            └───────────────────────┘
```

## Components

### Component 1: AI Agent UI

**Folder:** `frontend/ui/src/components/ai-assistant/`

Simple streaming chat panel. Shows what the agent does — text, tool calls, results. Nothing fancy.

- Slide-in panel triggered from header button (leverages existing `LayoutContext`)
- Message list with streaming text via SSE
- Minimal tool execution display (what tool ran, result summary)
- Input box, send button
- Conversation list (past sessions)
- Context-aware: passes current projectId, traceId, sessionId from URL params to agent
- Auth: existing NextAuth session, no new auth flow

The agent's text output IS the UI. No special rendering for traces, PRs, diffs, or domain-specific cards.

### Component 2: AI Agent Backend

**Folder:** `frontend/packages/agent/`

```
frontend/packages/agent/
├── package.json                # pi-agent-core, pi-ai, hono
├── tsconfig.json
├── src/
│   ├── index.ts                # Hono HTTP server entry
│   ├── agent.ts                # Agent runner factory (Mom's agent.ts pattern)
│   ├── session.ts              # Session CRUD (Prisma/PostgreSQL)
│   ├── sse.ts                  # Agent events → SSE stream bridge
│   ├── executors/
│   │   ├── interface.ts        # Executor interface (exec, readFile, writeFile)
│   │   ├── docker.ts           # Dev mode — docker run/exec
│   │   └── daytona.ts          # Production — Daytona SDK
│   └── prompts/
│       └── system.ts           # System prompt template
```

**Agent runner (agent.ts):**
- Creates pi-agent session per conversation
- Subscribes to agent events (message_update, tool_execution_start/end, agent_end)
- Pipes events through SSE bridge to frontend
- Standard pi-agent tools only: bash, read, write, edit
- Tools execute inside sandbox via executor when sandbox is active, or locally when not

**System prompt (prompts/system.ts):**
- Current workspace/project context (name, ID, environment)
- Available FastAPI endpoints with example curl commands
- ClickHouse table schemas (traces table, spans table — key columns + types)
- How to interpret trace data (span hierarchy, error levels, cost fields)
- What the user is currently looking at (trace ID, session ID passed from URL)
- Instructions for downloading traces to /workspace/traces/ for deep analysis

**HTTP API:**
- `POST /sessions` — Create new conversation session
- `GET /sessions` — List sessions for a workspace
- `POST /sessions/:id/messages` — Send message, returns SSE stream
- `DELETE /sessions/:id` — End session (destroys sandbox)

**Session management (session.ts):**
- New Prisma model: `AiSession` (id, workspaceId, userId, title, messages, createdAt, updatedAt)
- Conversation history persisted per session
- Session linked to workspace for multi-tenant isolation

### Component 3: Executor Abstraction (Sandbox)

**Folder:** `frontend/packages/agent/src/executors/`

Swappable executor — same interface, different backends.

```typescript
// interface.ts
interface Executor {
  init(): Promise<void>           // Create sandbox/container
  exec(command: string): Promise<{ stdout: string; stderr: string; exitCode: number }>
  writeFile(path: string, content: string): Promise<void>
  readFile(path: string): Promise<string>
  destroy(): Promise<void>        // Tear down sandbox/container
}
```

**DockerExecutor (dev):**
- `docker run` a basic image (ubuntu + git + curl)
- `docker exec` for commands
- Bind mount or `docker cp` for file operations
- Container destroyed on session end
- No external dependencies — works with just Docker

**DaytonaExecutor (prod):**
- Uses `daytona-sdk` npm package
- Pre-built snapshot (ubuntu + git + curl, no Node.js)
- Sandbox kept warm during session, destroyed on end
- `sandbox.process.executeCommand()` for exec
- `sandbox.fs` for file operations

**Config:**
```
# .env
SANDBOX_PROVIDER=docker   # dev (default)
SANDBOX_PROVIDER=daytona  # production
DAYTONA_API_KEY=...       # only needed for production
DAYTONA_API_URL=...       # only needed for production
```

**Workspace layout (both executors):**
```
/workspace/
├── traces/                     # Downloaded trace data
│   └── {trace_id}_{name}/
│       ├── tree.json           # Span hierarchy
│       └── spans/
│           └── {span_id}_{name}/
│               └── data.json   # Span data from ClickHouse
└── notes/                      # Agent's investigation notes
```

## What's NOT in MVP (Follow-up)

- GitHub App installation + private repo cloning
- PR/commit correlation and "was this fixed?" analysis
- Dedicated skill files for ClickHouse queries
- Code diff display, PR cards, "suggest fix" buttons
- Sandbox code execution (running customer tests, etc.)
- Multi-model routing (Sonnet for simple, Opus for complex)

## Sprint Plan

Single MVP sprint. Eight tasks, most parallelizable.

| # | Task | Deps | Parallel group |
|---|------|------|----------------|
| 1 | Agent service scaffold (pnpm package, Hono server, pi-mono deps, health check) | None | A |
| 2 | Agent runner + SSE bridge (Mom's agent.ts pattern, event subscription → SSE) | 1 | B |
| 3 | System prompt (FastAPI endpoints, ClickHouse schemas, project context template) | None | A |
| 4 | Session management (Prisma model AiSession, CRUD endpoints) | None | A |
| 5 | Executor abstraction (interface + DockerExecutor + DaytonaExecutor, env switch) | 1 | B |
| 6 | Chat panel UI (slide-in panel, SSE client, message list, streaming, input) | None | A |
| 7 | Next.js proxy routes (auth check, forward to agent service, SSE passthrough) | 4, 6 | C |
| 8 | tmux / make dev integration (add agent service to dev environment) | 1 | B |

**Parallel groups:**
- **Group A (start immediately):** Tasks 1, 3, 4, 6 — no dependencies, can all start day 1
- **Group B (after scaffold):** Tasks 2, 5, 8 — need task 1 done first
- **Group C (integration):** Task 7 — needs session mgmt + UI done

## Reference Code

| What | Where | What to take |
|------|-------|-------------|
| Agent runner pattern | `references/coding/pi-mono/packages/mom/src/agent.ts` | Session creation, event subscription, tool setup |
| Executor pattern | `references/coding/pi-mono/packages/mom/src/sandbox.ts` | exec() interface, Docker execution |
| Web-UI components | `references/coding/pi-mono/packages/web-ui/` | Visual/UX reference for chat panel |
| Daytona SDK examples | `references/sandbox/daytona/examples/typescript/` | Sandbox lifecycle, exec, file ops |
| Workspace design | `docs/plans/coding-agent/telemetry-processing-for-coding-agent-004.md` | Trace download format, tree.json, spans/ |
| Data access strategy | `docs/plans/coding-agent/telemetry-processing-for-coding-agent-005.md` | When to query vs download |
| Architecture decisions | `references/sandbox/daytona/learnings/daytona-use-006.md` | Agent outside sandbox rationale |
