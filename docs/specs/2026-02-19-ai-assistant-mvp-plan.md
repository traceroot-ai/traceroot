# AI Assistant MVP Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add an embedded AI debugging assistant to the TraceRoot UI that streams agent output, queries telemetry via existing APIs, and optionally uses a sandbox for deep trace analysis.

**Architecture:** Separate TypeScript service using `@mariozechner/pi-agent-core` (agent loop) and `@mariozechner/pi-ai` (multi-provider LLM). Follows Mom pattern — agent runs outside sandbox, standard tools (bash, read, write, edit) execute inside sandbox via swappable executor (Docker for dev, Daytona for prod). Frontend is a simple streaming chat panel in Next.js.

**Tech Stack:** TypeScript, Hono (HTTP server), pi-agent-core, pi-ai, Prisma, Next.js 15, React 19, SSE, Docker/Daytona

**Design Doc:** `docs/specs/2026-02-19-ai-assistant-mvp-design.md`

**Reference Code:**
- Mom agent pattern: `references/coding/pi-mono/packages/mom/src/agent.ts`
- Mom tools: `references/coding/pi-mono/packages/mom/src/tools/index.ts`
- Mom executor: `references/coding/pi-mono/packages/mom/src/sandbox.ts`
- Daytona TS examples: `references/sandbox/daytona/examples/typescript/`
- Workspace design: `docs/plans/coding-agent/telemetry-processing-for-coding-agent-004.md`

**Parallel Groups:**
- **Group A (no deps):** Tasks 1, 3, 4, 6
- **Group B (needs Task 1):** Tasks 2, 5, 8
- **Group C (needs Tasks 4+6):** Task 7

---

## Task 1: Agent Service Scaffold

Creates the new `frontend/packages/agent/` pnpm workspace package with Hono HTTP server and pi-mono dependencies.

**Files:**
- Create: `frontend/packages/agent/package.json`
- Create: `frontend/packages/agent/tsconfig.json`
- Create: `frontend/packages/agent/src/index.ts`

**Step 1: Create package.json**

```json
{
  "name": "@traceroot/agent",
  "version": "0.0.1",
  "private": true,
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "scripts": {
    "dev": "dotenv -e ../../../.env -- tsx watch src/index.ts",
    "build": "tsc",
    "start": "node dist/index.js",
    "clean": "rm -rf dist",
    "lint": "eslint .",
    "lint:fix": "eslint . --fix",
    "format": "prettier --write \"src/**/*.ts\"",
    "format:check": "prettier --check \"src/**/*.ts\"",
    "test": "vitest run",
    "test:watch": "vitest"
  },
  "dependencies": {
    "@traceroot/core": "workspace:*",
    "@mariozechner/pi-agent-core": "^0.52.0",
    "@mariozechner/pi-ai": "^0.52.0",
    "hono": "^4.0.0",
    "@hono/node-server": "^1.0.0"
  },
  "devDependencies": {
    "@types/node": "^22.0.0",
    "dotenv-cli": "^11.0.0",
    "tsx": "^4.0.0",
    "typescript": "^5.0.0",
    "vitest": "^3.0.0"
  }
}
```

**Step 2: Create tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "declaration": true,
    "declarationMap": true,
    "outDir": "./dist",
    "rootDir": "./src"
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist"]
}
```

**Step 3: Create src/index.ts (Hono server with health check)**

```typescript
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { prisma } from "@traceroot/core";

const app = new Hono();

const PORT = parseInt(process.env.AGENT_SERVICE_PORT || "8100", 10);

// Health check
app.get("/health", (c) => {
  return c.json({ status: "ok", service: "traceroot-agent" });
});

// Placeholder routes (implemented in Tasks 2, 4)
app.get("/sessions", (c) => c.json({ sessions: [] }));
app.post("/sessions", (c) => c.json({ error: "not implemented" }, 501));
app.post("/sessions/:id/messages", (c) => c.json({ error: "not implemented" }, 501));
app.delete("/sessions/:id", (c) => c.json({ error: "not implemented" }, 501));

// Graceful shutdown
let isShuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (isShuttingDown) return;
  isShuttingDown = true;
  console.log(`\n[Agent] Received ${signal}, shutting down...`);
  try {
    await prisma.$disconnect();
    console.log("[Agent] Cleanup complete");
    process.exit(0);
  } catch (error) {
    console.error("[Agent] Error during shutdown:", error);
    process.exit(1);
  }
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

async function main(): Promise<void> {
  console.log("[Agent] TraceRoot Agent Service starting...");

  // Verify DB connection
  try {
    const count = await prisma.project.count();
    console.log(`[Agent] Connected to database. Found ${count} projects.`);
  } catch (error) {
    console.error("[Agent] Failed to connect to database:", error);
    process.exit(1);
  }

  serve({ fetch: app.fetch, port: PORT }, (info) => {
    console.log(`[Agent] Listening on http://localhost:${info.port}`);
  });
}

main().catch((error) => {
  console.error("[Agent] Fatal error:", error);
  process.exit(1);
});

export { app };
```

**Step 4: Register package in pnpm workspace**

File to modify: `frontend/pnpm-workspace.yaml`

Add `packages/agent` to the packages list:
```yaml
packages:
  - "packages/*"
  - "ui"
  - "worker"
```

Note: `packages/*` glob already covers `packages/agent/`. No change needed unless the package is placed elsewhere. Verify this — if the glob covers it, skip this step.

**Step 5: Install dependencies and verify**

```bash
cd frontend && pnpm install
```

Expected: lockfile updated, `@traceroot/agent` appears in workspace.

**Step 6: Verify server starts**

```bash
cd frontend/packages/agent && pnpm dev
```

Expected: `[Agent] Listening on http://localhost:8100`

```bash
curl http://localhost:8100/health
```

Expected: `{"status":"ok","service":"traceroot-agent"}`

**Step 7: Commit**

```bash
git add frontend/packages/agent/ frontend/pnpm-lock.yaml
git commit -m "feat(agent): scaffold agent service package with Hono server"
```

---

## Task 2: Agent Runner + SSE Bridge

Implements the core agent runner following Mom's `agent.ts` pattern. Creates agent sessions using pi-agent-core, subscribes to events, and bridges them to SSE streams.

**Depends on:** Task 1

**Files:**
- Create: `frontend/packages/agent/src/agent.ts`
- Create: `frontend/packages/agent/src/sse.ts`
- Modify: `frontend/packages/agent/src/index.ts` (wire up routes)

**Reference:** `references/coding/pi-mono/packages/mom/src/agent.ts`

**Step 1: Create src/sse.ts (SSE stream helper)**

```typescript
import type { Context } from "hono";
import { streamSSE } from "hono/streaming";

export interface SSEEvent {
  event: string;
  data: string;
  id?: string;
}

export function createSSEStream(c: Context) {
  return streamSSE(c, async (stream) => {
    return stream;
  });
}

export function formatSSEEvent(event: SSEEvent): string {
  let result = "";
  if (event.id) result += `id: ${event.id}\n`;
  result += `event: ${event.event}\n`;
  result += `data: ${event.data}\n\n`;
  return result;
}
```

**Step 2: Create src/agent.ts (Agent runner factory)**

Study `references/coding/pi-mono/packages/mom/src/agent.ts` carefully before implementing. The key pattern:

```typescript
import { Agent, type AgentEvent, type AgentTool } from "@mariozechner/pi-agent-core";
import { getModel, registerBuiltins } from "@mariozechner/pi-ai";

// Register LLM providers on startup
registerBuiltins();

export interface AgentRunnerConfig {
  projectId: string;
  workspaceId: string;
  userId: string;
  systemPrompt: string;
  traceContext?: {
    traceId?: string;
    sessionId?: string;
  };
}

export interface AgentEventHandler {
  onEvent: (event: AgentEvent) => void;
  onError: (error: Error) => void;
  onDone: () => void;
}

export function createAgentRunner(config: AgentRunnerConfig) {
  const modelName = process.env.AGENT_MODEL || "claude-sonnet-4-5";
  const provider = process.env.AGENT_PROVIDER || "anthropic";
  const model = getModel(provider, modelName);

  // Standard pi-agent tools — bash, read, write, edit
  // These will be provided by the executor in Task 5.
  // For now, start with no tools (agent can only respond with text).
  const tools: AgentTool<any>[] = [];

  const agent = new Agent({
    initialState: {
      systemPrompt: config.systemPrompt,
      model,
      thinkingLevel: "off",
      tools,
    },
    convertToLlm: (messages) => messages,
    getApiKey: async () => {
      const key = process.env.ANTHROPIC_API_KEY || process.env.OPENAI_API_KEY || "";
      if (!key) throw new Error("No LLM API key configured");
      return key;
    },
  });

  return {
    agent,

    async run(userMessage: string, handler: AgentEventHandler): Promise<void> {
      const session = agent.createSession();

      session.subscribe(async (event: AgentEvent) => {
        try {
          handler.onEvent(event);
        } catch (err) {
          console.error("[Agent] Error in event handler:", err);
        }
      });

      try {
        await session.run(userMessage);
        handler.onDone();
      } catch (error) {
        handler.onError(error instanceof Error ? error : new Error(String(error)));
      }
    },

    abort() {
      // Agent abort if available
    },
  };
}
```

**Important:** The exact Agent/Session API may differ from this sketch. Before implementing, read:
1. `references/coding/pi-mono/packages/agent/src/agent.ts` for the actual `Agent` class API
2. `references/coding/pi-mono/packages/mom/src/agent.ts` for the usage pattern
3. Adapt the code above to match the actual API signatures

**Step 3: Wire up SSE streaming in src/index.ts**

Replace the placeholder `POST /sessions/:id/messages` route:

```typescript
import { streamSSE } from "hono/streaming";
import { createAgentRunner } from "./agent";
import { getSystemPrompt } from "./prompts/system";

app.post("/sessions/:id/messages", async (c) => {
  const sessionId = c.req.param("id");
  const body = await c.req.json<{ message: string; projectId: string; workspaceId: string; userId: string; traceContext?: { traceId?: string; sessionId?: string } }>();

  const systemPrompt = getSystemPrompt({
    projectId: body.projectId,
    traceContext: body.traceContext,
  });

  const runner = createAgentRunner({
    projectId: body.projectId,
    workspaceId: body.workspaceId,
    userId: body.userId,
    systemPrompt,
    traceContext: body.traceContext,
  });

  return streamSSE(c, async (stream) => {
    await new Promise<void>((resolve, reject) => {
      runner.run(body.message, {
        onEvent: (event) => {
          stream.writeSSE({
            event: event.type,
            data: JSON.stringify(event),
          });
        },
        onError: (error) => {
          stream.writeSSE({
            event: "error",
            data: JSON.stringify({ message: error.message }),
          });
          resolve();
        },
        onDone: () => {
          stream.writeSSE({ event: "done", data: "{}" });
          resolve();
        },
      });
    });
  });
});
```

**Step 4: Verify manually**

Start the agent service and test with curl:

```bash
curl -X POST http://localhost:8100/sessions/test-1/messages \
  -H "Content-Type: application/json" \
  -d '{"message": "Hello", "projectId": "test", "workspaceId": "test", "userId": "test"}'
```

Expected: SSE stream with agent events.

**Step 5: Commit**

```bash
git add frontend/packages/agent/src/
git commit -m "feat(agent): add agent runner and SSE bridge following Mom pattern"
```

---

## Task 3: System Prompt

Creates the system prompt template that gives the agent context about TraceRoot's APIs, ClickHouse schema, and the user's current view.

**Files:**
- Create: `frontend/packages/agent/src/prompts/system.ts`

**Reference:** Check existing FastAPI routes and ClickHouse schemas:
- `backend/rest/main.py` — API route definitions
- `backend/db/clickhouse/` — table schemas
- `docs/plans/coding-agent/telemetry-processing-for-coding-agent-004.md` — workspace format

**Step 1: Create src/prompts/system.ts**

```typescript
export interface SystemPromptContext {
  projectId: string;
  traceContext?: {
    traceId?: string;
    sessionId?: string;
  };
}

export function getSystemPrompt(ctx: SystemPromptContext): string {
  const parts: string[] = [];

  parts.push(`You are a debugging assistant for TraceRoot, an observability platform for AI agents.
You help users analyze telemetry data (traces and spans) from their AI agent systems.

## Current Context
- Project ID: ${ctx.projectId}
${ctx.traceContext?.traceId ? `- User is viewing trace: ${ctx.traceContext.traceId}` : ""}
${ctx.traceContext?.sessionId ? `- User is viewing session: ${ctx.traceContext.sessionId}` : ""}

## Available APIs

The TraceRoot backend runs at ${process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000/api/v1"}.
You can call these endpoints using curl with the bash tool.

### Trace Endpoints
- GET /traces?project_id={projectId}&limit=50 — List recent traces
- GET /traces/{traceId}?project_id={projectId} — Get trace detail with all spans
- GET /traces?project_id={projectId}&user_id={userId} — Filter by user
- GET /traces?project_id={projectId}&session_id={sessionId} — Filter by session

### Internal Endpoints (use X-Internal-Secret header)
- POST /internal/usage/details — Get usage stats for a workspace
  Body: {"workspace_id": "...", "start_date": "ISO", "end_date": "ISO"}
  Header: X-Internal-Secret: ${process.env.INTERNAL_SECRET || "internal-secret"}

## ClickHouse Schema

### traces table
Key columns: id, project_id, name, user_id, session_id, timestamp, latency, input, output,
metadata, tags, environment, release

### observations table (spans)
Key columns: id, trace_id, project_id, parent_observation_id, name, type (GENERATION|SPAN|EVENT),
start_time, end_time, latency, level (DEFAULT|DEBUG|WARNING|ERROR),
status_message, model, input, output, usage_details (JSON), cost_details (JSON),
metadata

## How to Analyze

1. Start by understanding what the user is asking about
2. Query the API to get relevant traces/spans
3. If you need deep analysis, download trace data to /workspace/traces/ and explore with read/grep
4. Look for: errors, high latency, cost anomalies, pattern changes
5. Explain findings clearly with specific span IDs and timestamps

## Workspace

If a sandbox is available, you have a /workspace/ directory for investigation:
- /workspace/traces/ — Downloaded trace data
- /workspace/notes/ — Your investigation notes

Keep your analysis focused and actionable. Show specific data points, not vague summaries.`);

  return parts.join("\n");
}
```

**Step 2: Verify prompt renders correctly**

Write a quick test:

```bash
cd frontend/packages/agent && pnpm test
```

Create `frontend/packages/agent/src/prompts/__tests__/system.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { getSystemPrompt } from "../system";

describe("getSystemPrompt", () => {
  it("includes project ID", () => {
    const prompt = getSystemPrompt({ projectId: "proj-123" });
    expect(prompt).toContain("proj-123");
  });

  it("includes trace context when provided", () => {
    const prompt = getSystemPrompt({
      projectId: "proj-123",
      traceContext: { traceId: "trace-abc" },
    });
    expect(prompt).toContain("trace-abc");
  });

  it("omits trace context when not provided", () => {
    const prompt = getSystemPrompt({ projectId: "proj-123" });
    expect(prompt).not.toContain("User is viewing trace:");
  });
});
```

**Step 3: Run test**

```bash
cd frontend/packages/agent && pnpm test
```

Expected: 3 tests pass.

**Step 4: Commit**

```bash
git add frontend/packages/agent/src/prompts/
git commit -m "feat(agent): add system prompt with TraceRoot API context"
```

---

## Task 4: Session Management

Adds the `AiSession` Prisma model and CRUD endpoints on the agent service.

**Files:**
- Modify: `frontend/packages/core/prisma/schema.prisma` (add AiSession + AiMessage models)
- Modify: `frontend/packages/agent/src/index.ts` (wire up session routes)
- Create: `frontend/packages/agent/src/session.ts`

**Step 1: Add Prisma models**

Append to `frontend/packages/core/prisma/schema.prisma`:

```prisma
model AiSession {
  id          String       @id @default(cuid()) @db.VarChar
  projectId   String       @map("project_id") @db.VarChar
  workspaceId String       @map("workspace_id") @db.VarChar
  userId      String       @map("user_id") @db.VarChar
  title       String?      @db.VarChar
  status      String       @default("active") @db.VarChar
  metadata    Json?        @db.JsonB
  createTime  DateTime     @default(now()) @map("create_time") @db.Timestamp(6)
  updateTime  DateTime     @default(now()) @updatedAt @map("update_time") @db.Timestamp(6)
  messages    AiMessage[]
  project     Project      @relation(fields: [projectId], references: [id], onDelete: Cascade, onUpdate: NoAction)

  @@index([projectId], map: "ix_ai_session_project_id")
  @@index([workspaceId], map: "ix_ai_session_workspace_id")
  @@index([userId], map: "ix_ai_session_user_id")
  @@map("ai_sessions")
}

model AiMessage {
  id          String     @id @default(cuid()) @db.VarChar
  sessionId   String     @map("session_id") @db.VarChar
  role        String     @db.VarChar
  content     String     @db.Text
  metadata    Json?      @db.JsonB
  createTime  DateTime   @default(now()) @map("create_time") @db.Timestamp(6)
  session     AiSession  @relation(fields: [sessionId], references: [id], onDelete: Cascade, onUpdate: NoAction)

  @@index([sessionId], map: "ix_ai_message_session_id")
  @@map("ai_messages")
}
```

**Note:** Also add `aiSessions AiSession[]` to the `Project` model's relation fields.

**Step 2: Run migration**

```bash
cd frontend/packages/core && pnpm db:migrate
```

Enter migration name: `add_ai_sessions`

**Step 3: Regenerate Prisma client**

```bash
cd frontend/packages/core && pnpm db:generate
```

**Step 4: Create src/session.ts**

```typescript
import { prisma } from "@traceroot/core";

export async function createSession(params: {
  projectId: string;
  workspaceId: string;
  userId: string;
  title?: string;
}) {
  return prisma.aiSession.create({
    data: {
      projectId: params.projectId,
      workspaceId: params.workspaceId,
      userId: params.userId,
      title: params.title,
    },
  });
}

export async function getSession(id: string) {
  return prisma.aiSession.findUnique({
    where: { id },
    include: { messages: { orderBy: { createTime: "asc" } } },
  });
}

export async function listSessions(params: {
  projectId: string;
  userId: string;
  limit?: number;
}) {
  return prisma.aiSession.findMany({
    where: {
      projectId: params.projectId,
      userId: params.userId,
    },
    orderBy: { createTime: "desc" },
    take: params.limit || 50,
  });
}

export async function addMessage(params: {
  sessionId: string;
  role: string;
  content: string;
  metadata?: Record<string, unknown>;
}) {
  return prisma.aiMessage.create({
    data: {
      sessionId: params.sessionId,
      role: params.role,
      content: params.content,
      metadata: params.metadata ?? undefined,
    },
  });
}

export async function deleteSession(id: string) {
  return prisma.aiSession.delete({ where: { id } });
}
```

**Step 5: Wire routes in src/index.ts**

Replace placeholder routes with:

```typescript
import { createSession, getSession, listSessions, deleteSession } from "./session";

app.post("/sessions", async (c) => {
  const body = await c.req.json<{
    projectId: string;
    workspaceId: string;
    userId: string;
    title?: string;
  }>();
  const session = await createSession(body);
  return c.json(session, 201);
});

app.get("/sessions", async (c) => {
  const projectId = c.req.query("projectId");
  const userId = c.req.query("userId");
  if (!projectId || !userId) {
    return c.json({ error: "projectId and userId required" }, 400);
  }
  const sessions = await listSessions({ projectId, userId });
  return c.json({ sessions });
});

app.get("/sessions/:id", async (c) => {
  const session = await getSession(c.req.param("id"));
  if (!session) return c.json({ error: "not found" }, 404);
  return c.json(session);
});

app.delete("/sessions/:id", async (c) => {
  await deleteSession(c.req.param("id"));
  return c.json({ ok: true });
});
```

**Step 6: Verify with curl**

```bash
# Create session
curl -X POST http://localhost:8100/sessions \
  -H "Content-Type: application/json" \
  -d '{"projectId": "<real-project-id>", "workspaceId": "<real-workspace-id>", "userId": "test-user"}'

# List sessions
curl "http://localhost:8100/sessions?projectId=<real-project-id>&userId=test-user"
```

**Step 7: Commit**

```bash
git add frontend/packages/core/prisma/ frontend/packages/agent/src/session.ts frontend/packages/agent/src/index.ts
git commit -m "feat(agent): add AiSession model and session CRUD endpoints"
```

---

## Task 5: Executor Abstraction

Implements the swappable executor interface with DockerExecutor (dev) and DaytonaExecutor (prod). Follows Mom's `sandbox.ts` pattern.

**Depends on:** Task 1

**Files:**
- Create: `frontend/packages/agent/src/executors/interface.ts`
- Create: `frontend/packages/agent/src/executors/docker.ts`
- Create: `frontend/packages/agent/src/executors/daytona.ts`
- Create: `frontend/packages/agent/src/executors/index.ts`

**Reference:** `references/coding/pi-mono/packages/mom/src/sandbox.ts`

**Step 1: Create src/executors/interface.ts**

```typescript
export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface Executor {
  /** Initialize the sandbox/container */
  init(): Promise<void>;

  /** Execute a shell command in the sandbox */
  exec(command: string, options?: { timeout?: number }): Promise<ExecResult>;

  /** Write a file in the sandbox */
  writeFile(path: string, content: string): Promise<void>;

  /** Read a file from the sandbox */
  readFile(path: string): Promise<string>;

  /** Check if the executor is ready */
  isReady(): boolean;

  /** Tear down the sandbox/container */
  destroy(): Promise<void>;
}
```

**Step 2: Create src/executors/docker.ts**

```typescript
import { execFile } from "child_process";
import { promisify } from "util";
import type { Executor, ExecResult } from "./interface";

const execFileAsync = promisify(execFile);

const DOCKER_IMAGE = process.env.SANDBOX_DOCKER_IMAGE || "ubuntu:24.04";
const WORKSPACE_DIR = "/workspace";

export class DockerExecutor implements Executor {
  private containerId: string | null = null;

  async init(): Promise<void> {
    console.log("[DockerExecutor] Creating container...");

    const { stdout } = await execFileAsync("docker", [
      "run", "-d",
      "--name", `traceroot-sandbox-${Date.now()}`,
      "-w", WORKSPACE_DIR,
      DOCKER_IMAGE,
      "sleep", "infinity",
    ]);

    this.containerId = stdout.trim();

    // Create workspace directories
    await this.exec(`mkdir -p ${WORKSPACE_DIR}/traces ${WORKSPACE_DIR}/notes`);

    // Install basic tools if not in image
    await this.exec("apt-get update -qq && apt-get install -y -qq curl git jq > /dev/null 2>&1 || true");

    console.log(`[DockerExecutor] Container ready: ${this.containerId.slice(0, 12)}`);
  }

  async exec(command: string, options?: { timeout?: number }): Promise<ExecResult> {
    if (!this.containerId) throw new Error("Container not initialized");

    try {
      const { stdout, stderr } = await execFileAsync("docker", [
        "exec", this.containerId,
        "bash", "-c", command,
      ], {
        timeout: options?.timeout || 30000,
        maxBuffer: 1024 * 1024 * 10, // 10MB
      });

      return { stdout, stderr, exitCode: 0 };
    } catch (error: any) {
      return {
        stdout: error.stdout || "",
        stderr: error.stderr || error.message,
        exitCode: error.code || 1,
      };
    }
  }

  async writeFile(path: string, content: string): Promise<void> {
    if (!this.containerId) throw new Error("Container not initialized");
    // Use docker exec with heredoc to write file
    await this.exec(`cat > ${path} << 'TRACEROOT_EOF'\n${content}\nTRACEROOT_EOF`);
  }

  async readFile(path: string): Promise<string> {
    const result = await this.exec(`cat ${path}`);
    if (result.exitCode !== 0) throw new Error(`File not found: ${path}`);
    return result.stdout;
  }

  isReady(): boolean {
    return this.containerId !== null;
  }

  async destroy(): Promise<void> {
    if (!this.containerId) return;
    console.log(`[DockerExecutor] Destroying container ${this.containerId.slice(0, 12)}`);
    try {
      await execFileAsync("docker", ["rm", "-f", this.containerId]);
    } catch {
      // Ignore errors during cleanup
    }
    this.containerId = null;
  }
}
```

**Step 3: Create src/executors/daytona.ts (stub — production)**

```typescript
import type { Executor, ExecResult } from "./interface";

// Daytona SDK will be installed when ready for production:
// import { Daytona } from "daytona-sdk";

export class DaytonaExecutor implements Executor {
  private sandboxId: string | null = null;

  async init(): Promise<void> {
    // TODO: Implement with Daytona SDK
    // const daytona = new Daytona();
    // const sandbox = await daytona.create({ snapshot: "traceroot-sandbox" });
    // this.sandboxId = sandbox.id;
    throw new Error("DaytonaExecutor not yet implemented. Use SANDBOX_PROVIDER=docker for dev.");
  }

  async exec(command: string, options?: { timeout?: number }): Promise<ExecResult> {
    // TODO: sandbox.process.executeCommand(command)
    throw new Error("Not implemented");
  }

  async writeFile(path: string, content: string): Promise<void> {
    // TODO: sandbox.fs.uploadFiles(...)
    throw new Error("Not implemented");
  }

  async readFile(path: string): Promise<string> {
    // TODO: sandbox.fs.downloadFile(path)
    throw new Error("Not implemented");
  }

  isReady(): boolean {
    return this.sandboxId !== null;
  }

  async destroy(): Promise<void> {
    // TODO: sandbox.delete()
    this.sandboxId = null;
  }
}
```

**Step 4: Create src/executors/index.ts (factory)**

```typescript
import type { Executor } from "./interface";
import { DockerExecutor } from "./docker";
import { DaytonaExecutor } from "./daytona";

export type { Executor, ExecResult } from "./interface";

export function createExecutor(): Executor {
  const provider = process.env.SANDBOX_PROVIDER || "docker";

  switch (provider) {
    case "docker":
      return new DockerExecutor();
    case "daytona":
      return new DaytonaExecutor();
    default:
      throw new Error(`Unknown sandbox provider: ${provider}`);
  }
}
```

**Step 5: Test DockerExecutor manually**

```bash
cd frontend/packages/agent && pnpm dev
```

In a separate terminal, test with a quick script or add a test endpoint temporarily.

**Step 6: Commit**

```bash
git add frontend/packages/agent/src/executors/
git commit -m "feat(agent): add executor abstraction with Docker (dev) and Daytona (prod) backends"
```

---

## Task 6: Chat Panel UI

Builds the frontend chat panel component — a slide-in panel with message list, streaming display, and input box.

**Files:**
- Create: `frontend/ui/src/features/ai-assistant/components/ai-assistant-panel.tsx`
- Create: `frontend/ui/src/features/ai-assistant/components/message-list.tsx`
- Create: `frontend/ui/src/features/ai-assistant/components/message-input.tsx`
- Create: `frontend/ui/src/features/ai-assistant/hooks/use-ai-session.ts`
- Create: `frontend/ui/src/features/ai-assistant/hooks/use-ai-stream.ts`
- Create: `frontend/ui/src/features/ai-assistant/types/index.ts`
- Modify: `frontend/ui/src/components/layout/app-layout.tsx` (add toggle button)

**Step 1: Create types**

File: `frontend/ui/src/features/ai-assistant/types/index.ts`

```typescript
export interface AiMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  timestamp: string;
  isStreaming?: boolean;
}

export interface AiSession {
  id: string;
  projectId: string;
  title: string | null;
  status: string;
  createTime: string;
}
```

**Step 2: Create SSE streaming hook**

File: `frontend/ui/src/features/ai-assistant/hooks/use-ai-stream.ts`

```typescript
"use client";

import { useState, useCallback, useRef } from "react";
import type { AiMessage } from "../types";

const AGENT_API_URL = process.env.NEXT_PUBLIC_AGENT_API_URL || "";

export function useAiStream() {
  const [messages, setMessages] = useState<AiMessage[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  const sendMessage = useCallback(async (params: {
    sessionId: string;
    message: string;
    projectId: string;
    workspaceId: string;
    userId: string;
    traceContext?: { traceId?: string; sessionId?: string };
  }) => {
    // Add user message
    const userMsg: AiMessage = {
      id: crypto.randomUUID(),
      role: "user",
      content: params.message,
      timestamp: new Date().toISOString(),
    };
    setMessages((prev) => [...prev, userMsg]);

    // Start streaming assistant response
    setIsStreaming(true);
    const assistantMsgId = crypto.randomUUID();

    setMessages((prev) => [...prev, {
      id: assistantMsgId,
      role: "assistant",
      content: "",
      timestamp: new Date().toISOString(),
      isStreaming: true,
    }]);

    const abortController = new AbortController();
    abortRef.current = abortController;

    try {
      const url = `${AGENT_API_URL}/sessions/${params.sessionId}/messages`;
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: params.message,
          projectId: params.projectId,
          workspaceId: params.workspaceId,
          userId: params.userId,
          traceContext: params.traceContext,
        }),
        signal: abortController.signal,
      });

      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      if (!response.body) throw new Error("No response body");

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          if (line.startsWith("data: ")) {
            try {
              const eventData = JSON.parse(line.slice(6));
              // Append text content from agent events
              if (eventData.type === "message_update" || eventData.content) {
                const text = eventData.content || eventData.text || "";
                if (text) {
                  setMessages((prev) =>
                    prev.map((msg) =>
                      msg.id === assistantMsgId
                        ? { ...msg, content: msg.content + text }
                        : msg
                    )
                  );
                }
              }
            } catch {
              // Skip unparseable lines
            }
          }
        }
      }
    } catch (error) {
      if ((error as Error).name !== "AbortError") {
        console.error("[AI Stream] Error:", error);
        setMessages((prev) =>
          prev.map((msg) =>
            msg.id === assistantMsgId
              ? { ...msg, content: msg.content || "Error: Failed to get response.", isStreaming: false }
              : msg
          )
        );
      }
    } finally {
      setIsStreaming(false);
      setMessages((prev) =>
        prev.map((msg) =>
          msg.id === assistantMsgId ? { ...msg, isStreaming: false } : msg
        )
      );
      abortRef.current = null;
    }
  }, []);

  const abort = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  return { messages, isStreaming, sendMessage, abort, setMessages };
}
```

**Step 3: Create message list component**

File: `frontend/ui/src/features/ai-assistant/components/message-list.tsx`

```tsx
"use client";

import type { AiMessage } from "../types";

interface MessageListProps {
  messages: AiMessage[];
}

export function MessageList({ messages }: MessageListProps) {
  return (
    <div className="flex-1 overflow-y-auto p-4 space-y-4">
      {messages.length === 0 && (
        <div className="text-center text-muted-foreground py-8">
          Ask me about your traces, errors, or performance.
        </div>
      )}
      {messages.map((msg) => (
        <div
          key={msg.id}
          className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}
        >
          <div
            className={`max-w-[85%] rounded-lg px-3 py-2 text-sm whitespace-pre-wrap ${
              msg.role === "user"
                ? "bg-primary text-primary-foreground"
                : "bg-muted"
            }`}
          >
            {msg.content}
            {msg.isStreaming && (
              <span className="inline-block w-2 h-4 ml-1 bg-current animate-pulse" />
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
```

**Step 4: Create message input component**

File: `frontend/ui/src/features/ai-assistant/components/message-input.tsx`

```tsx
"use client";

import { useState, type KeyboardEvent } from "react";

interface MessageInputProps {
  onSend: (message: string) => void;
  disabled?: boolean;
}

export function MessageInput({ onSend, disabled }: MessageInputProps) {
  const [input, setInput] = useState("");

  const handleSend = () => {
    const trimmed = input.trim();
    if (!trimmed || disabled) return;
    onSend(trimmed);
    setInput("");
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  return (
    <div className="border-t p-3">
      <div className="flex gap-2">
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Ask about your traces..."
          disabled={disabled}
          rows={1}
          className="flex-1 resize-none rounded-md border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-ring"
        />
        <button
          onClick={handleSend}
          disabled={disabled || !input.trim()}
          className="rounded-md bg-primary px-3 py-2 text-sm text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
        >
          Send
        </button>
      </div>
    </div>
  );
}
```

**Step 5: Create main panel component**

File: `frontend/ui/src/features/ai-assistant/components/ai-assistant-panel.tsx`

```tsx
"use client";

import { useEffect, useRef } from "react";
import { useParams } from "next/navigation";
import { useSession } from "next-auth/react";
import { MessageList } from "./message-list";
import { MessageInput } from "./message-input";
import { useAiStream } from "../hooks/use-ai-stream";

interface AiAssistantPanelProps {
  open: boolean;
  onClose: () => void;
}

export function AiAssistantPanel({ open, onClose }: AiAssistantPanelProps) {
  const params = useParams();
  const { data: session } = useSession();
  const { messages, isStreaming, sendMessage } = useAiStream();
  const sessionIdRef = useRef<string | null>(null);

  const projectId = params?.projectId as string | undefined;

  // Create a session on first open (or reuse existing)
  useEffect(() => {
    if (open && !sessionIdRef.current && projectId) {
      // For MVP, use a simple ID. Task 7 will create proper sessions via API.
      sessionIdRef.current = crypto.randomUUID();
    }
  }, [open, projectId]);

  if (!open) return null;

  const handleSend = (message: string) => {
    if (!sessionIdRef.current || !projectId || !session?.user) return;

    sendMessage({
      sessionId: sessionIdRef.current,
      message,
      projectId,
      workspaceId: "", // Will be resolved by proxy in Task 7
      userId: session.user.email || "",
    });
  };

  return (
    <div className="fixed right-0 top-0 h-full w-[400px] border-l bg-background shadow-lg z-50 flex flex-col">
      {/* Header */}
      <div className="flex items-center justify-between border-b px-4 py-3">
        <h3 className="font-semibold text-sm">AI Assistant</h3>
        <button
          onClick={onClose}
          className="text-muted-foreground hover:text-foreground text-lg"
        >
          &times;
        </button>
      </div>

      {/* Messages */}
      <MessageList messages={messages} />

      {/* Input */}
      <MessageInput onSend={handleSend} disabled={isStreaming} />
    </div>
  );
}
```

**Step 6: Add toggle button to app layout**

Modify `frontend/ui/src/components/layout/app-layout.tsx`:

Add state and render the panel. Find the layout component and add:

```typescript
// Add to imports
import { AiAssistantPanel } from "@/features/ai-assistant/components/ai-assistant-panel";

// Add state in the component
const [aiPanelOpen, setAiPanelOpen] = useState(false);

// Add toggle button in the header area (near existing header content)
<button
  onClick={() => setAiPanelOpen(!aiPanelOpen)}
  className="rounded-md p-2 text-muted-foreground hover:text-foreground hover:bg-muted"
  title="AI Assistant"
>
  AI
</button>

// Add panel at the end of the layout, before closing tag
<AiAssistantPanel open={aiPanelOpen} onClose={() => setAiPanelOpen(false)} />
```

**Important:** Read the actual `app-layout.tsx` file first and find the right insertion points. The layout uses `LayoutContext` — integrate with it, don't fight it.

**Step 7: Verify UI renders**

Start the frontend dev server and navigate to a project page. The AI button should appear in the header. Clicking it opens the panel. Typing a message and pressing Enter should attempt to stream (will fail until the agent service is running, which is expected).

**Step 8: Commit**

```bash
git add frontend/ui/src/features/ai-assistant/ frontend/ui/src/components/layout/app-layout.tsx
git commit -m "feat(ui): add AI assistant chat panel with SSE streaming"
```

---

## Task 7: Next.js Proxy Routes

Adds Next.js API routes that authenticate the user and proxy requests to the agent service.

**Depends on:** Tasks 4, 6

**Files:**
- Create: `frontend/ui/src/app/api/projects/[projectId]/ai/sessions/route.ts`
- Create: `frontend/ui/src/app/api/projects/[projectId]/ai/sessions/[sessionId]/messages/route.ts`

**Reference:** Existing API route patterns in `frontend/ui/src/app/api/`

**Step 1: Create sessions route**

File: `frontend/ui/src/app/api/projects/[projectId]/ai/sessions/route.ts`

```typescript
import { NextRequest, NextResponse } from "next/server";
import { requireAuth, requireProjectAccess, errorResponse } from "@/lib/auth-helpers";

const AGENT_SERVICE_URL = process.env.AGENT_SERVICE_URL || "http://localhost:8100";

type RouteParams = { params: Promise<{ projectId: string }> };

export async function GET(request: NextRequest, { params }: RouteParams) {
  const user = await requireAuth();
  if (!user) return errorResponse("Unauthorized", 401);

  const { projectId } = await params;
  const access = await requireProjectAccess(projectId, user.id);
  if (!access) return errorResponse("Forbidden", 403);

  const res = await fetch(
    `${AGENT_SERVICE_URL}/sessions?projectId=${projectId}&userId=${user.id}`
  );
  const data = await res.json();
  return NextResponse.json(data);
}

export async function POST(request: NextRequest, { params }: RouteParams) {
  const user = await requireAuth();
  if (!user) return errorResponse("Unauthorized", 401);

  const { projectId } = await params;
  const access = await requireProjectAccess(projectId, user.id);
  if (!access) return errorResponse("Forbidden", 403);

  const body = await request.json();

  const res = await fetch(`${AGENT_SERVICE_URL}/sessions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      projectId,
      workspaceId: access.workspaceId,
      userId: user.id,
      title: body.title,
    }),
  });

  const data = await res.json();
  return NextResponse.json(data, { status: 201 });
}
```

**Step 2: Create messages route (SSE passthrough)**

File: `frontend/ui/src/app/api/projects/[projectId]/ai/sessions/[sessionId]/messages/route.ts`

```typescript
import { NextRequest } from "next/server";
import { requireAuth, requireProjectAccess, errorResponse } from "@/lib/auth-helpers";

const AGENT_SERVICE_URL = process.env.AGENT_SERVICE_URL || "http://localhost:8100";

type RouteParams = { params: Promise<{ projectId: string; sessionId: string }> };

export async function POST(request: NextRequest, { params }: RouteParams) {
  const user = await requireAuth();
  if (!user) return errorResponse("Unauthorized", 401);

  const { projectId, sessionId } = await params;
  const access = await requireProjectAccess(projectId, user.id);
  if (!access) return errorResponse("Forbidden", 403);

  const body = await request.json();

  // Proxy to agent service, passthrough SSE stream
  const agentRes = await fetch(`${AGENT_SERVICE_URL}/sessions/${sessionId}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      message: body.message,
      projectId,
      workspaceId: access.workspaceId,
      userId: user.id,
      traceContext: body.traceContext,
    }),
  });

  if (!agentRes.ok || !agentRes.body) {
    return new Response(JSON.stringify({ error: "Agent service error" }), {
      status: agentRes.status,
      headers: { "Content-Type": "application/json" },
    });
  }

  // Passthrough the SSE stream
  return new Response(agentRes.body, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
    },
  });
}
```

**Step 3: Update frontend hook to use proxy URL**

Update `frontend/ui/src/features/ai-assistant/hooks/use-ai-stream.ts` — change the URL to go through Next.js:

```typescript
// Change from:
const url = `${AGENT_API_URL}/sessions/${params.sessionId}/messages`;
// To:
const url = `/api/projects/${params.projectId}/ai/sessions/${params.sessionId}/messages`;
```

**Step 4: Update panel to create session via API**

Update `frontend/ui/src/features/ai-assistant/components/ai-assistant-panel.tsx` to create sessions through the proxy:

```typescript
useEffect(() => {
  if (open && !sessionIdRef.current && projectId) {
    fetch(`/api/projects/${projectId}/ai/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    })
      .then((res) => res.json())
      .then((data) => {
        sessionIdRef.current = data.id;
      })
      .catch(console.error);
  }
}, [open, projectId]);
```

**Step 5: Add env vars**

Add to `.env.example` and `.env`:

```
AGENT_SERVICE_URL=http://localhost:8100
AGENT_SERVICE_PORT=8100
```

**Step 6: End-to-end test**

1. Start agent service: `cd frontend/packages/agent && pnpm dev`
2. Start frontend: `cd frontend/ui && pnpm dev`
3. Navigate to a project page
4. Click AI assistant button
5. Type a message and send
6. Verify SSE stream flows through: UI → Next.js proxy → Agent service → pi-agent → SSE back

**Step 7: Commit**

```bash
git add frontend/ui/src/app/api/projects/*/ai/ frontend/ui/src/features/ai-assistant/ .env.example
git commit -m "feat: add Next.js proxy routes for AI assistant with auth"
```

---

## Task 8: tmux / make dev Integration

Adds the agent service to the tmux-based dev environment so `make dev` starts it automatically.

**Depends on:** Task 1

**Files:**
- Modify: `tmux_tools/launcher.py`
- Modify: `.env.example` (add agent env vars)

**Step 1: Add agent service to tmux launcher**

Read `tmux_tools/launcher.py` and find the `make_driver()` function. Add a new `schema.Service` entry:

```python
schema.Service(
    title="Agent",
    command="cd frontend/packages/agent && pnpm dev",
    web_urls=[
        ("Agent API", f"http://localhost:{AGENT_PORT}"),
    ],
),
```

Also add near the top with other port constants:

```python
AGENT_PORT = int(os.environ.get("AGENT_SERVICE_PORT", "8100"))
```

And add to prerequisites:

```python
port_available(AGENT_PORT)
```

**Step 2: Add env vars to .env.example**

```
# AI Agent Service
AGENT_SERVICE_PORT=8100
AGENT_SERVICE_URL=http://localhost:8100
AGENT_MODEL=claude-sonnet-4-5
AGENT_PROVIDER=anthropic
SANDBOX_PROVIDER=docker
# DAYTONA_API_KEY=       # Production only
# DAYTONA_API_URL=       # Production only
```

**Step 3: Also add the same vars to `.env`**

```
AGENT_SERVICE_PORT=8100
AGENT_SERVICE_URL=http://localhost:8100
AGENT_MODEL=claude-sonnet-4-5
AGENT_PROVIDER=anthropic
SANDBOX_PROVIDER=docker
```

**Step 4: Verify with make dev**

```bash
make dev
```

Expected: tmux session shows a new "Agent" window running the agent service alongside Frontend, REST API, Celery Worker, and Billing Worker.

**Step 5: Commit**

```bash
git add tmux_tools/launcher.py .env.example
git commit -m "feat: add agent service to tmux dev environment"
```

---

## Integration Checklist

After all 8 tasks are complete, verify end-to-end:

1. `make dev` starts all services including Agent
2. Navigate to a project in the UI
3. Click AI assistant button → panel slides in
4. Type "What traces have errors in the last hour?" → Send
5. Agent streams response via SSE
6. Agent uses bash tool to curl FastAPI endpoints
7. Response appears in chat panel with streaming
8. Close panel, reopen → session persisted
9. List sessions → previous conversation visible

## Env Vars Summary

| Variable | Default | Purpose |
|----------|---------|---------|
| `AGENT_SERVICE_PORT` | `8100` | Agent HTTP server port |
| `AGENT_SERVICE_URL` | `http://localhost:8100` | Agent service URL (for Next.js proxy) |
| `AGENT_MODEL` | `claude-sonnet-4-5` | Default LLM model |
| `AGENT_PROVIDER` | `anthropic` | LLM provider (anthropic, openai, google, etc.) |
| `SANDBOX_PROVIDER` | `docker` | Sandbox backend (docker or daytona) |
| `ANTHROPIC_API_KEY` | — | Required for Anthropic models |
| `OPENAI_API_KEY` | — | Required for OpenAI models |
| `DAYTONA_API_KEY` | — | Production only |
| `DAYTONA_API_URL` | — | Production only |
