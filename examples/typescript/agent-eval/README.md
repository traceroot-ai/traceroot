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

By default the run reports to TraceRoot; with no `TRACEROOT_API_KEY` set, `main.ts` runs locally and reports nowhere. The model keys you need depend on the mode:

| Mode | Keys |
| --- | --- |
| default (OpenAI agent and judge) | `OPENAI_API_KEY` |
| `AGENT_PROVIDER=anthropic` (Claude agent and judge) | `ANTHROPIC_API_KEY` |
| `JUDGE_PROVIDER=jev` | `TYPESAFE_API_KEY`, plus the agent's key |

### Providers

The agent runs on `gpt-4o-mini` (default) or `claude-opus-5`. The judge follows the agent unless `JUDGE_PROVIDER` picks `openai`, `anthropic` or `jev`.

```bash
pnpm start                                              # OpenAI agent, OpenAI judge
AGENT_PROVIDER=anthropic pnpm start                     # Claude agent, Claude judge
AGENT_PROVIDER=anthropic JUDGE_PROVIDER=jev pnpm start  # Claude agent, Jev judge
```

The first line of the run shows which agent, judge and reporting mode are active. The Python twin is still OpenAI-only.

## What it does

Runs four tool-use cases through the agent, then scores each with:

- `callsExpectedTools` (code) — did the agent call the tools the case expects?
- `reportsExpectedFacts` (code) — does the answer state the expected numbers?
- `answerIsGrounded` (LLM judge) — does it give concrete values, not a hedge?

With `JUDGE_PROVIDER=jev`, one Jev scorer replaces `answerIsGrounded`:

- `answer_supported_by_tools` — do the tool results back up what the answer says? The score is one of `supports`, `contradicts` (a wrong price, another ticker's price, the wrong direction), `not_in_tools` (something the tools never returned) or `states_nothing` (a hedge or refusal); the case comment carries Jev's confidence and per-label probabilities.

The tool and number checks stay in code whichever judge runs.

The tools (`getStockPrice`, `calculate`) return fixed data, so every case has an exact answer. `TraceRoot.initialize()` traces the agent's model and tool calls, and `evaluate()` runs each case as its own trace and reports the run.
