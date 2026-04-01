# LangChain Code Agent

Multi-agent code generator using LangGraph, instrumented with [TraceRoot](https://traceroot.ai).

Orchestrates a pipeline with automatic retry on failure:

```
Plan → Code → Execute → Summarize (→ retry if failed)
```

## Features

- **Auto-instrumented**: All OpenAI calls via LangChain are automatically traced
- **LangGraph workflow**: State machine with conditional edges for retry logic
- **Python code execution**: Actually runs the generated code
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

- "Calculate the first 20 Fibonacci numbers and print them."
- "Find all prime numbers up to 100 using the Sieve of Eratosthenes."
- "Compute 15! (factorial of 15) and express it in scientific notation."

## How It Works

The agent uses a LangGraph state machine:

1. **Planner**: Creates a step-by-step plan for solving the query
2. **Coder**: Generates Python code based on the plan
3. **Executor**: Runs the Python code and captures output
4. **Retry Logic**: If execution fails, goes back to coder with error context
5. **Summarizer**: Creates a human-readable summary of the results

All steps are traced in TraceRoot with:
- Full LLM call details (prompts, completions, tokens)
- State transitions between nodes
- Code execution results
- Error handling and retry attempts
