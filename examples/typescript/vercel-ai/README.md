# Vercel AI SDK Agent

Multi-step tool-use agent built with the [Vercel AI SDK](https://sdk.vercel.ai/), instrumented with [TraceRoot](https://traceroot.ai).

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

Runs two demo queries that exercise multi-step tool use:
1. Weather comparison (San Francisco vs Tokyo)
2. Stock price lookup + calculation (NVDA +10%)

Tools: `getWeather`, `getStockPrice`, `calculate`
