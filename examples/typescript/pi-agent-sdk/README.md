# Pi Coding Agent SDK

Programmatically-embedded [Pi coding agent](https://pi.dev) session (`@earendil-works/pi-coding-agent`), instrumented with [TraceRoot](https://traceroot.ai).

## Setup

Requires Node >=22.19 — `@earendil-works/pi-coding-agent` is ESM-only and won't run on older LTS versions.

```bash
cp .env.example .env  # fill in your API keys
pnpm install
pnpm demo
```

## What it does

Runs three short-lived `AgentSession`s against a scratch workspace to exercise the distinct span shapes TraceRoot captures for a coding agent:

1. **No tools** — a question the model can answer directly. Produces an `AGENT → LLM` span only.
2. **Write + run** — write `add.js` and a test for it, then run the test with `node` via the `bash` tool. Produces `AGENT → TOOL (write)` ×2 and `AGENT → TOOL (bash)`.
3. **Tool error** — read a file that doesn't exist. Produces `AGENT → TOOL (read)` with `ERROR` status.

## Why three sessions instead of one?

Tool availability (`tools` / `noTools`) is set when an `AgentSession` is created — there's no per-prompt override. Each turn above needs a different tool configuration, so the demo creates a fresh session per turn rather than reusing one across all three.

## How the tracing works

`instrumentPiCodingAgent()` patches `AgentSession.prototype` before any session is created, so every session — however it's built — is traced automatically with full agent/LLM/tool span semantics. There's no `observe()` call to add and no manual span code: the package instruments the SDK directly, independent of the generic `@traceroot-ai/traceroot` SDK used in the other examples in this directory.

See the [`@traceroot-ai/pi` README](https://github.com/traceroot-ai/traceroot-ts/tree/main/packages/pi) for the full configuration surface.
