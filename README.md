<div align="center">
  <a href="https://traceroot.ai/">
    <img src="frontend/ui/public/images/traceroot_logo.png" alt="TraceRoot Logo">
  </a>

[TraceRoot]("https://traceroot.ai/") is an open-source observability platform for AI agents — Capturess traces, debug with AI that sees your source code and github history.

  [![Y Combinator][y-combinator-image]][y-combinator-url]
  [![License][license-image]][license-url]
  [![X (Twitter)][twitter-image]][twitter-url]
  [![Discord][discord-image]][discord-url]
  [![Documentation][docs-image]][docs-url]
  [![PyPI SDK Downloads][pypi-sdk-downloads-image]][pypi-sdk-downloads-url]

</div>

## Features

<div align="center">
  <kbd><img src="docs/images/rca_v1.png" alt="Agentic Debugging - Root Cause Analysis"></kbd>
</div>

<br>

| Feature | Description |
| ------- | ----------- |
| Tracing | Capture LLM calls, agent actions, and tool usage via OpenTelemetry-compatible SDK. Intelligently surfaces the traces that matter — noise filtered, signal prioritized. |
| Agentic Debugging | AI that sees all your traces, connects to a sandbox with your production source code, identifies the exact failing line, and correlates the failure with your GitHub commits, PRs, and issues. BYOK support for any model provider. |

## Why TraceRoot?

- **Traces alone don't scale.**

  As AI agent systems grow more complex, manually sifting through every trace is unsustainable. TraceRoot selectively screens your traces — filtering noise and surfacing only the ones that actually need attention, so you spend time fixing problems, not hunting for them.

- **Debugging ai agent system is painful.**

  Root-causing failures across agent hallucinations, tool call instabilities, and version changes is hard. TraceRoot's AI connects to a sandbox running your production source code, identifies the exact failing line, and cross-references your GitHub history — commits, PRs, open issues and creates PR to fix it.

- **Fully open source, no vendor lock-in.**

  Both the observability platform and the AI debugging layer are open source. BYOK support for any model provider — OpenAI, Anthropic, Gemini, xAI, DeepSeek, OpenRouter, Kimi, GLM and more.

## Documentation

Full documentation available at [traceroot.ai/docs](https://traceroot.ai/docs).

## Getting Started

### TraceRoot Cloud

The fastest way to get started. Ample storages and LLM tokens for testing, no credit card needed. Sign up [here](https://app.traceroot.ai)!

### Self-Hosting

- Developer mode: Run TraceRoot locally to contribute.

  ```bash
  # Get a copy of the latest repo
  git clone https://github.com/traceroot-ai/traceroot.git
  cd traceroot

  # Hosted the infras in docker and app itself locally
  make dev
  ```
  For more details, see [CONTRIBUTING.md](CONTRIBUTING.md).

- Local docker mode: Run TraceRoot locally to test.

  ```bash
  # Get a copy of the latest repo
  git clone https://github.com/traceroot-ai/traceroot.git
  cd traceroot

  # Hosted everything in docker
  make prod
  ```

- [Terraform (AWS)](./deploy/): Run TraceRoot on k8s with Helm and Terraform. This is for production hosting. Still in experimental stage.

## SDK

| Language | Repository |
| -------- | ---------- |
| Python | [traceroot-py](https://github.com/traceroot-ai/traceroot-py) |

## Python SDK Quickstart

```bash
pip install traceroot openai
```

```bash
# Add these in the `.env` file in root directory
TRACEROOT_API_KEY="tr-0f29d..."
TRACEROOT_HOST_URL="https://app.traceroot.ai"  # cloud (default)
```

```python
import traceroot
from traceroot import Integration, observe
from openai import OpenAI

traceroot.initialize(integrations=[Integration.OPENAI])
client = OpenAI()

@observe(name="my_agent", type="agent")
def my_agent(query: str) -> str:
    response = client.chat.completions.create(
        model="gpt-4",
        messages=[{"role": "user", "content": query}],
    )
    return response.choices[0].message.content

if __name__ == "__main__":
    my_agent("What's the weather in SF?")
```

## Security & Privacy

Your data security and privacy are our top priorities. Learn more in our [Security and Privacy](SECURITY.md) documentation.

## Community

Special Thanks for [pi-mono](https://github.com/badlogic/pi-mono) project, which powers the foundation of our agentic debugging runtime!

**Contributing** 🤝: If you're interested in contributing, you can check out our guide [here](/CONTRIBUTING.md). All types of help are appreciated :)

**Support** 💬: If you need any type of support, we're typically most responsive on our [Discord channel](https://discord.gg/tPyffEZvvJ), but feel free to email us `founders@traceroot.ai` too!

## License

This project is licensed under [Apache 2.0](LICENSE) with additional [Enterprise features](./ee/LICENSE).

## Contributors

<a href="https://github.com/traceroot-ai/traceroot/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=traceroot-ai/traceroot" />
</a>

<!-- Links -->
[discord-image]: https://img.shields.io/discord/1395844148568920114?logo=discord&labelColor=%235462eb&logoColor=%23f5f5f5&color=%235462eb
[discord-url]: https://discord.gg/tPyffEZvvJ
[license-image]: https://img.shields.io/badge/License-Apache%202.0-blue.svg
[license-url]: https://opensource.org/licenses/Apache-2.0
[docs-image]: https://img.shields.io/badge/docs-traceroot.ai-0dbf43
[docs-url]: https://traceroot.ai/docs
[pypi-sdk-downloads-image]: https://static.pepy.tech/badge/traceroot
[pypi-sdk-downloads-url]: https://pypi.python.org/pypi/traceroot
[y-combinator-image]: https://img.shields.io/badge/Combinator-S25-orange?logo=ycombinator&labelColor=white
[y-combinator-url]: https://www.ycombinator.com/companies/traceroot-ai
[twitter-image]: https://img.shields.io/twitter/follow/TracerootAI
[twitter-url]: https://x.com/TracerootAI
