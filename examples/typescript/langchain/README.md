# LangChain Code Agent

Multi-agent code generator using LangGraph, instrumented with [TraceRoot](https://traceroot.ai).

Orchestrates 4 agents in a pipeline with automatic retry on failure:

```
Plan → Code → Execute → Summarize (→ retry if failed)
```

## Setup

```bash
cp .env.example .env  # fill in your API keys
pnpm install
```

## Usage

```bash
pnpm demo
```

## What it does

Runs three demo queries:
1. First 20 Fibonacci numbers
2. Primes up to 100 (Sieve of Eratosthenes)
3. 15! in scientific notation
