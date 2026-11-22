# AWS Bedrock Tool Agent

ReAct-style agent using the [Bedrock Converse API](https://docs.aws.amazon.com/bedrock/latest/userguide/conversation-inference.html) with tool use, instrumented with [traceroot](https://traceroot.ai).

## Setup

```bash
cp .env.example .env  # fill in your API key and AWS settings
```

Configure AWS credentials the usual way (`aws configure`, environment variables, or an instance role).

With `uv` (recommended):
```bash
uv run --no-project --python 3.13 --with-requirements requirements.txt python main.py
```

Or with pip:
```bash
pip install -r requirements.txt
python main.py
```

## What it does

Runs two demo queries that exercise tool use via the Bedrock Converse API:
1. Weather comparison (San Francisco vs Tokyo)
2. Stock price lookup + calculation (NVDA +10%)

Tools: `get_weather`, `get_stock_price`, `calculate`, `get_current_time`
