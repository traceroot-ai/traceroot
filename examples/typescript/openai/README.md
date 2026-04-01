# OpenAI Tool Agent

ReAct-style agent with OpenAI tool calling, instrumented with [TraceRoot](https://traceroot.ai).

## Features

- **Auto-instrumented**: All OpenAI calls are automatically traced with token usage, latency, and model info
- **Tool calling**: Weather, stock prices, calculator, web search, current time
- **Demo mode**: Runs predefined queries to show the agent in action

## Setup

```bash
# Install dependencies (from repo root)
pnpm install

# Copy environment variables
cp .env.example .env
# Edit .env with your API keys
```

## Usage

```bash
pnpm demo
```

## Example Queries

- "What's the weather in San Francisco and Tokyo? Compare them."
- "What's NVDA stock price? If it goes up 10%, what would the new price be?"
- "Search for information about AI observability and summarize what you find."

## How It Works

The agent uses a ReAct loop:
1. Receives user input
2. Decides which tool(s) to call (if any)
3. Executes tools and feeds results back to the model
4. Generates a final response

All steps are automatically traced in TraceRoot, showing:
- LLM calls with prompts, completions, and token usage
- Tool executions with inputs and outputs
- Full conversation flow with timing
