# AWS Bedrock (Converse)

Calls Amazon Bedrock using the [Converse API](https://docs.aws.amazon.com/bedrock/latest/userguide/conversation-inference.html), with traces sent through [TraceRoot](https://traceroot.ai).

## Setup

```bash
cp .env.example .env
pnpm install
```

Fill in `TRACEROOT_API_KEY`, `AWS_REGION`, and `BEDROCK_MODEL_ID`. Configure AWS credentials the usual way (for example `aws configure`, environment variables, or an instance role).

## Usage

```bash
pnpm demo
```
