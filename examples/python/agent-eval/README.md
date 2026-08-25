# Agent Eval (Python)

An offline eval of a tool-using [pydantic-ai](https://ai.pydantic.dev) agent, scored with [TraceRoot](https://traceroot.ai). Three scorers — two code checks and an `answer_is_grounded` LLM judge — run over four tool-use cases whose data is fixed, so every question has an exact ground-truth answer (NVDA at `495.20`, a 10% rise to `544.72`). Mirror of [`examples/typescript/agent-eval`](../../typescript/agent-eval), so both runs converge into one history.

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
