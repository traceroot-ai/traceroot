<div align="center">
  <a href="https://traceroot.ai/">
    <img src="misc/images/traceroot_logo.png" alt="TraceRoot Logo">
  </a>
</div>

<div align="center">

[![Product Hunt](https://api.producthunt.com/widgets/embed-image/v1/featured.svg?post_id=1004840&theme=dark&t=1756093935224)](https://www.producthunt.com/products/traceroot-ai?embed=true&utm_source=badge-featured&utm_medium=badge&utm_source=badge-traceroot-ai)

[![Testing Status][testing-image]][testing-url]
[![Documentation][docs-image]][docs-url]
[![Discord][discord-image]][discord-url]
[![PyPI Version][pypi-image]][pypi-url]
[![PyPI SDK Downloads][pypi-sdk-downloads-image]][pypi-sdk-downloads-url]
[![npm version][npm-image]][npm-url]
[![TraceRoot.AI Website][company-website-image]][company-website-url]
[![X][zecheng-x-image]][zecheng-x-url]
[![X][xinwei-x-image]][xinwei-x-url]
[![Y Combinator][y-combinator-image]][y-combinator-url]

</div>

🔍 **TraceRoot** helps engineers debug production issues **10× faster** using AI-powered analysis of traces, logs, and code context.

- Visit the [TraceRoot website](https://traceroot.ai) to start debugging your production issues.
- Explore the [TraceRoot documentation](https://docs.traceroot.ai) to get started with the TraceRoot library.
- Join our [Discord community](https://discord.gg/tPyffEZvvJ) to learn more and discuss on AI Agent for observability, debugging, tracing and root cause analysis.

## About

TraceRoot accelerates the debugging process with AI-powered insights. It integrates seamlessly into your development workflow, providing real-time trace and log analysis, code context understanding, and intelligent assistance.

## Demo

<div align="center">
  <img src="misc/images/product_git_v1.gif" alt="TraceRoot Demo" width="100%">
</div>

## Features

| Feature                                           | Description                                                                   |
| ------------------------------------------------- | ----------------------------------------------------------------------------- |
| 🚀 [Ease of Use](#getting-started-with-traceroot) | Get started with TraceRoot in minutes with our simple setup process           |
| 🤖 LLM Flexibility                                | Bring your own model (OpenAI, Anthropic, local LLMs) for AI-powered debugging |
| 🌐 Distributed Services                           | Cross-platform support with distributed setup for enterprise-scale debugging  |
| 💻 AI Debugging Interface                         | Cursor-like interface specialized for debugging with AI assistance            |
| 🔌 Integration Support                            | Native integration with GitHub, Notion, Slack, and other tools                |

## Getting started with TraceRoot

### TraceRoot Cloud (Recommended)

The fastest and most reliable way to start with TraceRoot is by signing up for free to [TraceRoot Cloud](https://auth.traceroot.ai/) for a **7-day trial**.
You’ll get:

- **100k** traces + logs storage with **30-day retention**
- **1M** LLM tokens
- AI agent with chat mode

Usually new features will be available in TraceRoot Cloud first, and then they will be released to the self-hosted version.

### Self-hosting TraceRoot (Advanced)

If you want to self-host TraceRoot, you can deploy a starter instance in one line on Linux with Docker:

```bash
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/traceroot-ai/traceroot/HEAD/bin/deploy-starter)"
```

Open source deployments should scale to a certain point and may not cover all the features, thus we recommend [migrating to TraceRoot Cloud](https://traceroot.ai).

In general the open source version will start the UI at [http://localhost:3000](http://localhost:3000) and the API at [http://localhost:8000](http://localhost:8000).

If you don't want to use Docker, please refer to the [DEVELOPMENT.md](DEVELOPMENT.md) for more details to setup the environment manually.

## Setting up TraceRoot

Whether you're using [TraceRoot Cloud](https://traceroot.ai) or our open source version, it's required to use our SDK:

### Available SDKs

| Language              | Repository                                                           |
| --------------------- | -------------------------------------------------------------------- |
| Python                | [traceroot-sdk](https://github.com/traceroot-ai/traceroot-sdk)       |
| JavaScript/TypeScript | [traceroot-sdk-ts](https://github.com/traceroot-ai/traceroot-sdk-ts) |

For more details on SDK usage and examples, please check out this [Quickstart](https://docs.traceroot.ai/quickstart).

## AI Agent Framework

Here is an overview for our AI Agent Framework:

### Context Model

<div align="center">
  <a href="https://traceroot.ai/">
    <img src="misc/images/context-model.png" alt="Context Model" width="90%" max-width="1200px">
  </a>
</div>

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

## Contributors

Thanks to all our contributors for helping make TraceRoot better!

<a href="https://github.com/traceroot-ai/traceroot/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=traceroot-ai/traceroot" />
</a>

[company-website-image]: https://img.shields.io/badge/website-traceroot.ai-black
[company-website-url]: https://traceroot.ai
[discord-image]: https://img.shields.io/discord/1395844148568920114?logo=discord&labelColor=%235462eb&logoColor=%23f5f5f5&color=%235462eb
[discord-url]: https://discord.gg/tPyffEZvvJ
[docs-image]: https://img.shields.io/badge/docs-traceroot.ai-0dbf43
[docs-url]: https://docs.traceroot.ai
[npm-image]: https://img.shields.io/npm/v/traceroot-sdk-ts?style=flat-square&logo=npm&logoColor=fff
[npm-url]: https://www.npmjs.com/package/traceroot-sdk-ts
[pypi-image]: https://badge.fury.io/py/traceroot.svg
[pypi-sdk-downloads-image]: https://static.pepy.tech/badge/traceroot
[pypi-sdk-downloads-url]: https://pypi.python.org/pypi/traceroot
[pypi-url]: https://pypi.python.org/pypi/traceroot
[testing-image]: https://github.com/traceroot-ai/traceroot/actions/workflows/test.yml/badge.svg
[testing-url]: https://github.com/traceroot-ai/traceroot/actions/workflows/test.yml
[xinwei-x-image]: https://img.shields.io/twitter/follow/xinwei_97?style=social
[xinwei-x-url]: https://x.com/xinwei_97
[y-combinator-image]: https://img.shields.io/badge/Combinator-S25-orange?logo=ycombinator&labelColor=white
[y-combinator-url]: https://www.ycombinator.com/companies/traceroot-ai
[zecheng-x-image]: https://img.shields.io/twitter/follow/zechengzh?style=social
[zecheng-x-url]: https://x.com/zechengzh
