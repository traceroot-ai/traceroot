# Agent Eval (Python)

An offline eval of a tool-using [pydantic-ai](https://ai.pydantic.dev) agent, scored with [TraceRoot](https://traceroot.ai) over four tool-use cases whose data is fixed, so every question has an exact ground-truth answer (NVDA at `495.20`, a 10% rise to `544.72`). Mirror of [`examples/typescript/agent-eval`](../../typescript/agent-eval), so both runs converge into one history.

## Setup

```bash
cp .env.example .env  # fill in your API keys
```

With `uv` (recommended):
```bash
uv run --no-project --python 3.13 --with-requirements requirements.txt python main.py
```

Or with pip:
```bash
pip install -r requirements.txt
python main.py
```

By default the run reports to TraceRoot; with no `TRACEROOT_API_KEY` set, `main.py` runs locally and reports nowhere (you still need `OPENAI_API_KEY` for the agent and judge).

## What it does

Runs four tool-use cases through the agent, then scores each with:

- `calls_expected_tools` (code) — did the agent call the tools the case expects?
- `reports_expected_facts` (code) — does the answer state the expected numbers?
- `answer_is_grounded` (LLM judge) — does it give concrete values, not a hedge?

The tools (`get_stock_price`, `calculate`) return fixed data, so every case has an exact answer. `traceroot.initialize()` traces the agent's model and tool calls, and `evaluate()` runs each case as its own trace and reports the run.
