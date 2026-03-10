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

</div>

## Features

| Feature | Description |
| ------- | ----------- |
| Tracing | Capture LLM calls, agent actions, and tool usage via OpenTelemetry-compatible SDK |
| Agentic Debugging | Agentic root cause analysis with github integration and  BYOK support |

## Getting Started

### TraceRoot Cloud (Recommended)

- TODO

### Self-Hosting

```bash
git clone https://github.com/traceroot-ai/traceroot.git
cd traceroot
make dev
```

For manual setup without Docker, see [DEVELOPMENT.md](DEVELOPMENT.md).

## SDK

| Language | Repository |
| -------- | ---------- |
| Python | [traceroot-sdk](https://github.com/traceroot-ai/traceroot-sdk) |

See the [Quickstart](https://docs.traceroot.ai/quickstart) for usage examples.

## Community

**Contributing**: Check out our [guide](/CONTRIBUTING.md) — all help is appreciated!

**Support**: Join us on [Discord](https://discord.gg/tPyffEZvvJ) or email `founders@traceroot.ai`

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