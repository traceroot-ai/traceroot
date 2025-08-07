<div align="center">
  <a href="https://traceroot.ai/">
    <img src="misc/images/traceroot_logo.png" alt="TraceRoot Logo" width="70%">
  </a>
</div>

<div align="center">

[![Testing Status][testing-image]][testing-url]
[![Documentation][docs-image]][docs-url]
[![Discord][discord-image]][discord-url]
[![PyPI Version][pypi-image]][pypi-url]
[![PyPI SDK Downloads][pypi-sdk-downloads-image]][pypi-sdk-downloads-url]
[![npm version][npm-image]][npm-url]
[![TraceRoot.AI Website][company-website-image]][company-website-url]
[![X][zecheng-x-image]][zecheng-x-url]
[![X][xinwei-x-image]][xinwei-x-url]

</div>

🔍 TraceRoot helps engineers debug production issues 10x faster using AI-powered analysis of traces, logs, and code context.

- Check out [traceroot.ai website](https://traceroot.ai) to start using TraceRoot to debug your production issues.
- Visit the [traceroot docs](https://docs.traceroot.ai) to get started with traceroot library.
- Join our [Discord](https://discord.gg/tPyffEZvvJ) for discussion

## Features

| Feature                                           | Description                                                                   |
| ------------------------------------------------- | ----------------------------------------------------------------------------- |
| 🚀 [Ease of Use](#getting-started-with-traceroot) | Get started with TraceRoot in minutes with our simple setup process           |
| 🤖 LLM Flexibility                                | Bring your own model (OpenAI, Anthropic, local LLMs) for AI-powered debugging |
| 🌐 Distributed Services                           | Cross-platform support with distributed setup for enterprise-scale debugging  |
| 💻 AI Debugging Interface                         | Cursor-like interface specialized for debugging with AI assistance            |
| 🔌 Integration Support                            | Native integration with GitHub, Notion, and other development tools           |

## Getting started with TraceRoot

### TraceRoot Cloud (Recommended)

The fastest and most reliable way to get started with TraceRoot is signing up
for free to [TraceRoot Cloud](https://auth.traceroot.ai/) for a 7 day trial.
You will have 150k trace + logs storage with 30d retentions, 1.5M LLM tokens,
and AI agent with chat mode.

### Self-hosting the open-source deploy (Advanced)

#### Installation

You can install the latest version of TraceRoot with the following command:

Install the dependencies locally:

```bash
git clone https://github.com/traceroot-ai/traceroot.git
cd traceroot

# Create and activate a virtual environment
python3.11 -m venv venv
source venv/bin/activate

# Install TraceRoot with dependencies excluding optional dependencies
pip install --upgrade pip
pip install -e .
```

#### Local Usage

For local usage, all of your data will be stored locally.

Run the below command to intialize environment variables.

```bash
source .env.development
```

You can use the TraceRoot framework locally by following the [README.md in the `ui` directory](ui/README.md) and [README.md in the `rest` directory](rest/README.md).

Also, you can build the latest docker image and run the docker container by following the [README.md in the `docker` directory](docker/public/README.md).

This will start the UI at [http://localhost:3000](http://localhost:3000) and the API at [http://localhost:8000](http://localhost:8000).

Before using the TraceRoot framework, you need to setup the Jaeger docker container at first. It will be used to store the traces and logs and capture the traces and logs from our SDK which is integrated with your applications.

```bash
docker run -d --name jaeger \
  -e COLLECTOR_OTLP_ENABLED=true \
  -p 16686:16686 \
  -p 14268:14268 \
  -p 14250:14250 \
  -p 4317:4317 \
  -p 4318:4318 \
  cr.jaegertracing.io/jaegertracing/jaeger:2.8.0
```

In local mode, the first step is to go to the integration page and connect with your GitHub account (optional) with your GitHub token.
You also need to put your LLM API key in the integration page.

## Setting up TraceRoot

Whether you're using [TraceRoot Cloud](https://traceroot.ai) or self-hosting, you'll need our SDK:

```bash
pip install traceroot==0.0.4a7
```

Create `.traceroot-config.yaml` in your project root:

```yaml
local_mode: true  # set to false for cloud version
service_name: "your-service-name"
github_owner: "your-github-owner"
github_repo_name: "your-github-repo-name"
github_commit_hash: "your-github-commit-hash"
```

For more details or the SDK usage and examples, please checkout this [Quickstart](https://docs.traceroot.ai/quickstart).

## AI Agent Framework

Here is an overview for our AI Agent Framework:

### Context Model

<div align="center">
  <a href="https://traceroot.ai/">
    <img src="misc/images/context-model.png" alt="Context Model" width="90%" max-width="1200px">
  </a>
</div>

### Chunking

TODO

### Explainability

Please checkout the [README.md in the `rest/agent` directory](rest/agent/README.md) for more details.

## Citation

If you find our exploratory TraceRoot useful in your research, please consider citing:

```bibtex
@article{traceroot_2025,
  title={TraceRoot Is All You Need for Debugging and Tracing},
  author={Zecheng Zhang and Xinwei He},
  year = {2025},
  publisher = {GitHub},
  url = {https://github.com/traceroot-ai/traceroot}
}
```

[company-website-image]: https://img.shields.io/badge/website-traceroot.ai-148740
[company-website-url]: https://traceroot.ai
[discord-image]: https://img.shields.io/discord/1395844148568920114?logo=discord&labelColor=%235462eb&logoColor=%23f5f5f5&color=%235462eb
[discord-url]: https://discord.gg/tPyffEZvvJ
[docs-image]: https://img.shields.io/badge/docs-traceroot.ai-0dbf43
[docs-url]: https://docs.traceroot.ai
[npm-image]: https://img.shields.io/npm/v/traceroot-sdk-ts?style=flat-square&logo=npm&logoColor=fff
[npm-url]: https://www.npmjs.com/package/traceroot-sdk-ts
[pypi-image]: https://badge.fury.io/py/traceroot.svg
[pypi-sdk-downloads-image]: https://img.shields.io/pypi/dm/traceroot
[pypi-sdk-downloads-url]: https://pypi.python.org/pypi/traceroot
[pypi-url]: https://pypi.python.org/pypi/traceroot
[testing-image]: https://github.com/traceroot-ai/traceroot/actions/workflows/test.yml/badge.svg
[testing-url]: https://github.com/traceroot-ai/traceroot/actions/workflows/test.yml
[xinwei-x-image]: https://img.shields.io/twitter/follow/xinwei_97?style=social
[xinwei-x-url]: https://x.com/xinwei_97
[zecheng-x-image]: https://img.shields.io/twitter/follow/zechengzh?style=social
[zecheng-x-url]: https://x.com/zechengzh
