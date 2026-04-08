# Mastra Weather Agent (TypeScript)

Weather agent using [Mastra](https://mastra.ai) with Claude Haiku, instrumented with [TraceRoot](https://traceroot.ai).

## Setup

```bash
cp .env.example .env  # fill in your API keys
pnpm install
```

## Examples

### `agent.ts` — generate (non-streaming)

```bash
pnpm demo
```

Runs two weather queries through a Mastra agent using `agent.generate()`. The agent is obtained via `mastra.getAgent()`.

### `streaming.ts` — direct agent reference + streaming

```bash
pnpm demo:streaming
```

Shows that you don't need `mastra.getAgent()` — you can define the agent at module scope, export it, and call `agent.stream()` directly. This is the pattern used when `chatAgent` (or similar) is imported and used across files without going through the Mastra instance.

**How tracing still works:** `TraceRootExporter` hooks into Mastra's internal event bus, so you need one `new Mastra({ agents: {...}, observability: ... })` call to initialize the pipeline. But after that, calling the agent variable directly is identical to calling `mastra.getAgent()` — both reference the same enriched object.

Both examples:
- Run two weather queries (SF weather + NY vs London comparison)
- Share a `threadId` so both calls appear grouped under the same session in TraceRoot
- Use the `get_weather` mock tool
