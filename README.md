<div align="center">
  <a href="https://traceroot.ai/">
    <img src="misc/images/traceroot_logo.png" alt="TraceRoot Logo">
  </a>

[TraceRoot]("https://traceroot.ai/") is Open-source observability and self-healing layer for AI agents. Capture traces, debug with AI, ship with confidence.

  [![Documentation][docs-image]][docs-url]
  [![Discord][discord-image]][discord-url]
  [![PyPI Version][pypi-image]][pypi-url]
  [![PyPI SDK Downloads][pypi-sdk-downloads-image]][pypi-sdk-downloads-url]
  [![Y Combinator][y-combinator-image]][y-combinator-url]
  [![X (Twitter)][twitter-image]][twitter-url]

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

`.env`
```bash
TRACEROOT_API_KEY=tr_...
TRACEROOT_HOST_URL=https://app.traceroot.ai  # Cloud (default)
# TRACEROOT_HOST_URL=http://localhost:8000   # Local development mode
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

The fastest way to get started. [Sign up for free](https://traceroot.ai) — no credit card required.

### Self-Hosting

<details>
<summary><b>Developer mode</b></summary>

```bash
git clone https://github.com/traceroot-ai/traceroot.git
cd traceroot
make dev
```

For more details, see [DEVELOPMENT.md](DEVELOPMENT.md).
</details>

<details>
<summary><b>Local production mode</b></summary>

```bash
git clone https://github.com/traceroot-ai/traceroot.git
cd traceroot
make prod
```
</details>

<details>
<summary><b>Terraform (AWS)</b></summary>

Infrastructure-as-code deployment configs are available in [`deploy/`](./deploy/). Currently under active development.
</details>

## SDK

| Language | Repository |
| -------- | ---------- |
| Python | [traceroot-sdk](https://github.com/traceroot-ai/traceroot-sdk) |

## Documentation

Full documentation available at **[docs.traceroot.ai](https://docs.traceroot.ai)**.

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
[docs-image]: https://img.shields.io/badge/docs-traceroot.ai-0dbf43
[docs-url]: https://docs.traceroot.ai
[pypi-image]: https://badge.fury.io/py/traceroot.svg
[pypi-sdk-downloads-image]: https://static.pepy.tech/badge/traceroot
[pypi-sdk-downloads-url]: https://pypi.python.org/pypi/traceroot
[pypi-url]: https://pypi.python.org/pypi/traceroot
[y-combinator-image]: https://img.shields.io/badge/Combinator-S25-orange?logo=ycombinator&labelColor=white
[y-combinator-url]: https://www.ycombinator.com/companies/traceroot-ai
[twitter-image]: https://img.shields.io/twitter/follow/TracerootAI
[twitter-url]: https://x.com/TracerootAI
