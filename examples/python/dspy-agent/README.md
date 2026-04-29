# DSPy Agent

A minimal [DSPy](https://dspy.ai/) chain-of-thought QA module, instrumented with [TraceRoot](https://traceroot.ai).

## Setup

```bash
cp .env.example .env  # fill in your API keys
```

With `uv` (recommended):

```bash
uv run --no-project --python 3.13 --with-requirements requirements.txt python main.py
```

## What it does

Defines a `CoTQA` module that wraps `dspy.ChainOfThought("question -> answer")` and runs it against three demo questions covering arithmetic word problems, scientific reasoning, and a classic logic puzzle. DSPy auto-generates the reasoning prompt; the OpenInference DSPy instrumentor turns each predictor invocation, language-model call, and reasoning step into spans that show up in your TraceRoot UI.

## How instrumentation is wired

```python
import traceroot
from traceroot import Integration

traceroot.initialize(integrations=[Integration.DSPY])
```

That single call activates `openinference.instrumentation.dspy.DSPyInstrumentor`, which patches DSPy modules and predictors to emit OpenTelemetry spans. The `@observe` decorator wraps the demo entrypoint so the per-session span groups everything in a single trace.
