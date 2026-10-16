# AWS Bedrock Tool Agent

ReAct-style agent using Amazon Bedrock's [Converse API](https://docs.aws.amazon.com/bedrock/latest/userguide/conversation-inference.html) with tool use, instrumented with [TraceRoot](https://traceroot.ai).

## Setup

```bash
cp .env.example .env  # fill in your API keys
```

With `uv` (recommended):
```bash
uv run --no-project --python 3.13 --with-requirements requirements.txt python main.py
```

Fill in `TRACEROOT_API_KEY`, `AWS_REGION`, and `BEDROCK_MODEL_ID`. Configure AWS credentials the usual way (for example `aws configure`, environment variables, or an instance role).

> If you authenticate with `aws login` (IAM Identity Center browser login), also install the CRT credential provider: `uv pip install "botocore[crt]"` (or `pip install "botocore[crt]"`).

## What it does

Runs two demo queries that exercise tool use via the Bedrock Converse API:
1. Weather comparison (San Francisco vs Tokyo)
2. Stock price lookup + calculation (NVDA +10%)

Tools: `get_weather`, `get_stock_price`, `calculate`, `get_current_time`
