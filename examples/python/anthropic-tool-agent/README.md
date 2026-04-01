# Anthropic ReAct Agent with Traceroot Observability

A ReAct-style agent using Anthropic's tool_use API with full Traceroot tracing.

## Setup

```bash
cp env.example .env
# Fill in TRACEROOT_API_KEY, TRACEROOT_HOST_URL, ANTHROPIC_API_KEY
pip install -r requirements.txt
```

## Run

```bash
python main.py
```

## Trace Structure

```
demo_session (agent)
  └── agent_turn (agent)
        ├── Anthropic messages.create (auto-instrumented)
        ├── execute_tool (span)
        │     └── get_weather (tool)
        ├── Anthropic messages.create (auto-instrumented)
        └── final response
```

### Nested Structure

- **`@observe` decorator** provides the agent/tool hierarchy
- **`Integration.ANTHROPIC`** auto-instruments `client.messages.create()` calls
- Combined, you get full nested traces with LLM calls inside agent turns

## Tools

| Tool | Description |
|------|-------------|
| `get_weather` | Simulated weather data for cities |
| `get_stock_price` | Simulated stock prices |
| `calculate` | Safe math expression evaluator |
| `get_current_time` | Current date and time |
