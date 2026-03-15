<div align="center">
  <a href="https://traceroot.ai/">
    <img src="misc/images/traceroot_logo.png" alt="TraceRoot Logo">
  </a>

[TraceRoot]("https://traceroot.ai/") is Open-source observability and self-healing layer for AI agents. Capture traces, debug with AI, ship with confidence.

  [![Y Combinator][y-combinator-image]][y-combinator-url]
  [![License][license-image]][license-url]
  [![X (Twitter)][twitter-image]][twitter-url]
  [![Discord][discord-image]][discord-url]
  [![Documentation][docs-image]][docs-url]
  [![PyPI SDK Downloads][pypi-sdk-downloads-image]][pypi-sdk-downloads-url]

</div>

## Features

| Feature | Description |
| ------- | ----------- |
| Tracing | Capture LLM calls, agent actions, and tool usage via OpenTelemetry-compatible SDK |
| Agentic Debugging | AI-native root cause analysis with GitHub integration and BYOK support |

## Why TraceRoot?

- **Traces alone don't scale.** As AI agent systems grow more complex, manually sifting through traces is not sustainable. TraceRoot pairs structured observability with AI-powered analysis so you can pinpoint issues, not just see them.
- **Debugging agents is painful.** Root-causing failures across agent hallucinations, tool call instabilities, and version changes is challenging. TraceRoot provides AI-native debugging that connects your traces to your code version and bug history.
- **Fully open source, no vendor lock-in.** Both the observability platform and the AI debugging layer are open source. BYOK support for any model provider — OpenAI, Anthropic, Gemini, DeepSeek, and more.

## Quickstart

```bash
pip install traceroot openai
```

```bash
# Add these in the `.env` file in root directory
TRACEROOT_API_KEY=tr-0f29d...
TRACEROOT_HOST_URL=https://app.traceroot.ai  # cloud (default)
# TRACEROOT_HOST_URL=http://localhost:8000   # local development mode
```

```python
import traceroot
from traceroot import Integration, observe
from openai import OpenAI

traceroot.initialize(integrations=[Integration.OPENAI])
client = OpenAI()

@observe(name="my_agent", type="llm")
def my_agent(query: str) -> str:
    response = client.chat.completions.create(
        model="gpt-4",
        messages=[{"role": "user", "content": query}],
    )
    return response.choices[0].message.content

if __name__ == "__main__":
    my_agent("What's the weather in SF?")
```

See the [Quickstart Guide](https://docs.traceroot.ai/quickstart) for more examples.

## Getting Started

### TraceRoot Cloud

The fastest way to get started. Ample storages and LLM tokens for testing, no credit card needed. [Sign up here!](https://app.traceroot.ai)

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
</details>

- Local docker mode: Run TraceRoot locally to test.

```bash
# Get a copy of the latest repo
git clone https://github.com/traceroot-ai/traceroot.git
cd traceroot

# Hosted everything in docker
make prod
```

- Terraform (AWS): Run TraceRoot on k8s with Helm and Terraform. This is for production hosting.

Infrastructure-as-code deployment configs are available in [`deploy`](./deploy/). This is still in testing stage.

## SDK

| Language | Repository |
| -------- | ---------- |
| Python | [traceroot-sdk](https://github.com/traceroot-ai/traceroot-sdk) |

## Documentation

Full documentation available at [docs.traceroot.ai](https://docs.traceroot.ai).

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
[docs-url]: https://docs.traceroot.ai
[pypi-sdk-downloads-image]: https://static.pepy.tech/badge/traceroot
[pypi-sdk-downloads-url]: https://pypi.python.org/pypi/traceroot
[y-combinator-image]: https://img.shields.io/badge/Combinator-S25-orange?logo=ycombinator&labelColor=white
[y-combinator-url]: https://www.ycombinator.com/companies/traceroot-ai
[twitter-image]: https://img.shields.io/twitter/follow/TracerootAI
[twitter-url]: https://x.com/TracerootAI
