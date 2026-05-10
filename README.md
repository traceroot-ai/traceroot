<div align="center">
  <a href="https://traceroot.ai/">
    <img src="frontend/ui/public/images/traceroot_logo.png" alt="TraceRoot Logo">
  </a>

[TraceRoot]("https://traceroot.ai/") is an open-source observability platform for AI agents — Capture traces, debug with AI that sees your source code and Github history.

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

- **Debugging AI agent systems is painful.**

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

## Integrations

### Model Providers

| Integration | Supports | Description |
| ----------- | -------- | ----------- |
| [OpenAI](https://traceroot.ai/docs/integrations/openai) | Python, JS/TS | Automated instrumentation of Chat Completions and Responses API. |
| [Anthropic](https://traceroot.ai/docs/integrations/anthropic) | Python, JS/TS | Automated instrumentation of the Messages API. |
| [Google Gemini](https://traceroot.ai/docs/integrations/gemini) | Python | Automated instrumentation via the Google GenAI SDK. |
| [Mistral](https://traceroot.ai/docs/integrations/mistral) | Python | Automated instrumentation of Mistral chat completions, tool calls, and streaming responses. |

### Agent Frameworks

| Integration | Supports | Description |
| ----------- | -------- | ----------- |
| [LangChain & LangGraph](https://traceroot.ai/docs/integrations/langchain) | Python, JS/TS | Automated instrumentation by passing callback handler to LangChain application. |
| [LangChain DeepAgents](https://traceroot.ai/docs/integrations/langchain-deepagents) | Python, JS/TS | Automated instrumentation by passing callback handler to DeepAgents pipeline. |
| [Claude Agent SDK](https://traceroot.ai/docs/integrations/claude-agent-sdk) | Python, JS/TS | Automated instrumentation of agent invocations, subagent delegations, tool calls, and token usage. |
| [OpenAI Agents SDK](https://traceroot.ai/docs/integrations/openai-agents-sdk) | Python, JS/TS | Automated instrumentation of agent runs, tool executions, and handoff transitions. |
| [Mastra](https://traceroot.ai/docs/integrations/mastra) | JS/TS | Automated instrumentation via the TraceRoot OTLP exporter. |
| [Vercel AI SDK](https://traceroot.ai/docs/integrations/vercel-ai) | JS/TS | Native OpenTelemetry tracing via `experimental_telemetry` — no `instrumentModules` config required. |
| [AutoGen](https://traceroot.ai/docs/integrations/autogen) | Python | Automated instrumentation of multi-agent conversations, agent loops, and tool calls. |
| [LlamaIndex](https://traceroot.ai/docs/integrations/llamaindex) | Python | Automated instrumentation of RAG pipelines, document ingestion, retrieval, and LLM synthesis. |
| [CrewAI](https://traceroot.ai/docs/integrations/crewai) | Python | Automated instrumentation of multi-agent collaborative workflows and task executions. |
| [Agno](https://traceroot.ai/docs/integrations/agno) | Python | Automated instrumentation of agent runs, tool calls, and multi-step reasoning. |
| [DSPy](https://traceroot.ai/docs/integrations/dspy) | Python | Automated instrumentation of module executions, signature predictions, and underlying LLM calls. |
| [Google ADK](https://traceroot.ai/docs/integrations/google-adk) | Python | Automated instrumentation of agent runs, tool executions, and the multi-turn agent loop. |

> Don't see your framework or provider? [Request an integration](https://github.com/traceroot-ai/traceroot/issues).

## SDK

| Language | Repository |
| -------- | ---------- |
| Python | [traceroot-py](https://github.com/traceroot-ai/traceroot-py) |
| TypeScript | [traceroot-ts](https://github.com/traceroot-ai/traceroot-ts) |

## Python SDK Quickstart

```bash
pip install traceroot openai
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
        model="gpt-4o",
        messages=[{"role": "user", "content": query}],
    )
    return response.choices[0].message.content

if __name__ == "__main__":
    my_agent("What's the weather in SF?")
```

## TypeScript SDK Quickstart

```sh
npm install @traceroot-ai/traceroot openai
```

```typescript
import OpenAI from 'openai';
import { TraceRoot, observe } from '@traceroot-ai/traceroot';

TraceRoot.initialize({ instrumentModules: { openAI: OpenAI } });
const openai = new OpenAI();

const myAgent = observe({ name: 'my_agent', type: 'agent' }, async (query: string) => {
  const response = await openai.chat.completions.create({
    model: 'gpt-4o',
    messages: [{ role: 'user', content: query }],
  });
  return response.choices[0].message.content;
});

async function main() {
  try {
    await myAgent("What's the weather in SF?");
  } finally {
    await TraceRoot.shutdown();
  }
}

main().catch(console.error);
```

## Security & Privacy

Your data security and privacy are our top priorities. Learn more in our [Security and Privacy](SECURITY.md) documentation.

## Community

Special Thanks for [pi-mono](https://github.com/badlogic/pi-mono) project, which powers the foundation of our agentic debugging runtime!

**Contributing** 🤝: If you're interested in contributing, you can check out our guide [here](/CONTRIBUTING.md). All types of help are appreciated :)

**Support** 💬: If you need any type of support, we're typically most responsive on our [Discord channel](https://discord.gg/TM2m3CtKuC), but feel free to email us `founders@traceroot.ai` too!

## License

This project is licensed under [Apache 2.0](LICENSE) with additional [Enterprise features](./ee/LICENSE).

## Contributors

<a href="https://github.com/traceroot-ai/traceroot/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=traceroot-ai/traceroot" />
</a>

<!-- Links -->
[discord-image]: https://img.shields.io/discord/1395844148568920114?logo=discord&labelColor=%235462eb&logoColor=%23f5f5f5&color=%235462eb
[discord-url]: https://discord.gg/TM2m3CtKuC
[license-image]: https://img.shields.io/badge/License-Apache%202.0-blue.svg
[license-url]: https://opensource.org/licenses/Apache-2.0
[docs-image]: https://img.shields.io/badge/docs-traceroot.ai-0dbf43
[docs-url]: https://traceroot.ai/docs
[pypi-sdk-downloads-image]: https://static.pepy.tech/badge/traceroot
[pypi-sdk-downloads-url]: https://pypi.python.org/pypi/traceroot
[y-combinator-image]: https://img.shields.io/badge/Combinator-S25-orange?logo=ycombinator&labelColor=white
[y-combinator-url]: https://www.ycombinator.com/companies/traceroot-ai
[twitter-image]: https://img.shields.io/twitter/follow/TraceRootAI
[twitter-url]: https://x.com/TraceRootAI
