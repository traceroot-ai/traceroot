# OpenRouter Chat Example

OpenRouter is OpenAI-compatible, so TraceRoot captures these calls through the existing OpenAI instrumentation.

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

Uses the OpenAI TypeScript SDK with `baseURL: "https://openrouter.ai/api/v1"`, sends a chat completion through an OpenRouter model, and exports the trace with TraceRoot's OpenAI instrumentation.