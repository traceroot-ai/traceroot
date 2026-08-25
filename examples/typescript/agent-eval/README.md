# Agent Eval (TypeScript)

An offline eval of a tool-using agent, built with the [Vercel AI SDK](https://sdk.vercel.ai/) and [TraceRoot](https://traceroot.ai). The agent looks up stock prices and does arithmetic with tools whose data is fixed, so every question has an exact ground-truth answer.

This is the mirror of [`examples/python/agent-eval`](../../python/agent-eval): the same four questions and expected facts, so the two runs converge into one history.

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

## What it evaluates

The agent (`agent.ts`) exposes `runAgent({ question }) -> { answer, toolsUsed, steps }`. `main.ts` scores each case three ways:

| Scorer | Kind | Checks |
|--------|------|--------|
| `calls_expected_tools` | code | The agent called the tools the case expects |
| `reports_expected_facts` | code | The answer states the exact expected numbers (via `mentions()`) |
| `answer_is_grounded` | LLM judge (`claude-haiku-4-5`) | The answer gives concrete values rather than hedging |

The dataset (`dataset.ts`) has four tool-use cases with exact facts, e.g. NVDA at `495.20` and a 10% rise to `544.72`.

## Reporting

By default the run reports to TraceRoot using the same credentials as the tracing SDK (`TRACEROOT_API_KEY`, optional `TRACEROOT_HOST_URL`). `main.ts` prints the run's dashboard URL when it's available.

No credentials? `main.ts` handles it automatically: when `TRACEROOT_API_KEY` is unset it sets `local: true` on the `evaluate()` call for you, so the eval runs in full and reports nowhere. This lets you clone and run without a TraceRoot API key (you still need `OPENAI_API_KEY` for the agent and `ANTHROPIC_API_KEY` for the judge — `local` only turns off TraceRoot reporting, not the LLM calls).

## Cross-SDK convergence

`main.ts` sets `evaluationKey: "agent-tool-eval"` and the dataset uses the same name and key as the Python example. Running both SDKs against that shared identity groups the two runs under one evaluation, so you can diff a TypeScript candidate against a Python one in a single history.

## Environment

- `TRACEROOT_API_KEY` — reports the run (omit it and `main.ts` runs locally instead)
- `TRACEROOT_HOST_URL` — optional; self-hosted or local dev server
- `OPENAI_API_KEY` — the agent's model (`gpt-4o-mini`)
- `ANTHROPIC_API_KEY` — the `answer_is_grounded` judge (`claude-haiku-4-5`)
