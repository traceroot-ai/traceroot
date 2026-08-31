# Agent Eval (TypeScript)

An offline eval of a tool-using [Vercel AI SDK](https://sdk.vercel.ai/) agent, scored with [TraceRoot](https://traceroot.ai) over four tool-use cases whose data is fixed, so every question has an exact ground-truth answer (NVDA at `495.20`, a 10% rise to `544.72`). Mirror of [`examples/python/agent-eval`](../../python/agent-eval), so both runs converge into one history.

## Setup

```bash
cp .env.example .env  # fill in your API keys
pnpm install
```

## Usage

```bash
pnpm start   # main.ts — run the eval
pnpm agent   # agent.ts — the system under evaluation, on its own
```

By default the run reports to TraceRoot; with no `TRACEROOT_API_KEY` set, `main.ts` runs locally and reports nowhere (you still need `OPENAI_API_KEY` for the agent and judge).

## What it does

Runs four tool-use cases through the agent, then scores each with:

- `callsExpectedTools` (code) — did the agent call the tools the case expects?
- `reportsExpectedFacts` (code) — does the answer state the expected numbers?
- `answerIsGrounded` (LLM judge) — does it give concrete values, not a hedge?

The tools (`getStockPrice`, `calculate`) return fixed data, so every case has an exact answer. `TraceRoot.initialize()` traces the agent's model and tool calls, and `evaluate()` runs each case as its own trace and reports the run.
