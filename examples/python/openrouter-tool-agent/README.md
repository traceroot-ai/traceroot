# OpenRouter Chat Example

OpenRouter is OpenAI-compatible, so TraceRoot captures these calls through the existing OpenAI integration.

## Setup

```bash
cp .env.example .env  # fill in your API keys
pip install -r requirements.txt
```

## Usage

```bash
python main.py
```

## What it does

Uses the OpenAI Python SDK with `base_url="https://openrouter.ai/api/v1"`, sends a chat completion through an OpenRouter model, and exports the trace with `Integration.OPENAI`.