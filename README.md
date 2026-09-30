<div align="center">
  <a href="https://traceroot.ai/">
    <img src="frontend/ui/public/images/traceroot_logo.png" alt="TraceRoot Logo">
  </a>

### Open Source Self-improving Layer for AI Agents

[TraceRoot](https://traceroot.ai/) turns production traces into actionable feedback and evals, closing the self-improving loop with your coding agent.

**[Try Cloud](https://app.traceroot.ai) · [Getting Started](#getting-started) · [CLI](#cli-quickstart) · [Self-Hosting](#self-hosting) · [Docs](https://traceroot.ai/docs)**

  [![Y Combinator][y-combinator-image]][y-combinator-url]
  [![License][license-image]][license-url]
  [![X (Twitter)][twitter-image]][twitter-url]
  [![Discord][discord-image]][discord-url]
  [![Documentation][docs-image]][docs-url]
  [![PyPI SDK Downloads][pypi-sdk-downloads-image]][pypi-sdk-downloads-url]
  [![Ask DeepWiki](https://img.shields.io/badge/Ask-DeepWiki-5562EA)](https://deepwiki.com/traceroot-ai/traceroot)

</div>

<p align="center">
  <a href="./README.md"><img alt="README in English" src="https://img.shields.io/badge/English-f8f8f8"></a>
  <a href="./README.zh.md"><img alt="简体中文版自述文件" src="https://img.shields.io/badge/简体中文-f8f8f8"></a>
  <a href="./README.ko.md"><img alt="한국어 README" src="https://img.shields.io/badge/한국어-f8f8f8"></a>
</p>

## Features

<p align="center">
  <a href="https://traceroot.ai/docs/detectors/get-started">
    <img src="docs/images/detector_findings_v1.png" alt="TraceRoot detector findings with a selected finding and its trace context" width="100%">
  </a>
</p>
<p align="center"><em>Detectors surface findings from production traces so you can decide what to improve next.</em></p>

| Feature | Description |
| ---------- | --------------- |
| [Tracing](https://traceroot.ai/docs/tracing/get-started) | Capture LLM calls, tool use, and agent steps with OpenTelemetry-compatible Python and TypeScript SDKs. Inspect inputs, outputs, latency, tokens, and cost. |
| [Detectors](https://traceroot.ai/docs/detectors/get-started) | Define behaviors to look for in production traces, configure sampling and judge models, and review findings. |
| [Datasets](https://traceroot.ai/docs/evals/datasets) | Author, version, and publish the cases you want your agent to handle well. |
| [Evaluations](https://traceroot.ai/docs/evals/get-started) | Run your system against a dataset, score each case, and compare candidate versions. Each case is also a trace you can inspect. |
| [CLI](https://github.com/traceroot-ai/traceroot-cli) | Read and export traces, inspect detectors and findings, and bring that context into your coding workflow. |
| Dashboards & alerts | Track quality, latency, and cost, and configure threshold alerts. |
| In-app AI assistant | Explore traces with an agent that can access your source code and GitHub context. Use a hosted model or bring your own key. |

## Why TraceRoot?

- **Traces alone don't scale.**

  As AI agent systems grow more complex, manually sifting through every trace is unsustainable. TraceRoot's Detectors selectively screen incoming traces — flagging hallucinations, tool failures, logic errors, and safety issues automatically, so you spend time fixing problems, not hunting for them.

- **Debugging AI agent systems in production is painful.**

  Root-causing failures across agent hallucinations, tool call instabilities, and version changes is hard. TraceRoot's AI connects to a sandbox running your production source code, identifies the exact failing line, cross-references your GitHub history — commits, PRs, open issues — and opens a PR to fix it.

- **Agent improvement should be systematic, not ad hoc.**

  Most teams debug production issues and move on — the learning evaporates. TraceRoot connects online and offline evaluation in a single loop: Detectors evaluate live traffic, confirmed failures become golden datasets, and offline evals verify every fix against them. Release over release, your agent gets measurably more robust and performant — improvement becomes a repeatable process, not a one-off firefight.

- **Fully open source, no vendor lock-in.**

  Both the observability platform and the AI debugging layer are open source. BYOK support for any model provider — OpenAI, Anthropic, Gemini, xAI, DeepSeek, OpenRouter, Kimi, GLM and more.

## Star TraceRoot

If you like what we’re building, give TraceRoot a star ⭐ to help more developers discover it.

<p align="center">
  <a href="https://github.com/traceroot-ai/traceroot">
    <img src="docs/images/github-star-demo.gif" alt="How to star the TraceRoot repository on GitHub" width="100%">
  </a>
</p>

## Getting Started

### TraceRoot Cloud

The fastest way to get started. [Sign up for TraceRoot Cloud](https://app.traceroot.ai)!

### Self-Hosting

Run locally with Docker:

```bash
git clone https://github.com/traceroot-ai/traceroot.git
cd traceroot
cp .env.example .env
make prod-lite
```

Open [localhost:3000](http://localhost:3000). See the [self-hosting guide](https://traceroot.ai/docs/developer/self-hosting) for details.

## CLI Quickstart

Use the [TraceRoot CLI](https://github.com/traceroot-ai/traceroot-cli#readme) with your coding agent.

```bash
npm install -g traceroot-cli
traceroot login
```

## Integrations

### Native SDKs

| Language | Repository |
| -------- | ---------- |
| Python | [traceroot-py](https://github.com/traceroot-ai/traceroot-py) |
| TypeScript | [traceroot-ts](https://github.com/traceroot-ai/traceroot-ts) |

<details open>
<summary>Supported frameworks and model providers</summary>

### Agent Frameworks

| Integration | Supports | Description |
| ----------- | -------- | ----------- |
| [Agno](https://traceroot.ai/docs/integrations/agno) | Python | Automated instrumentation of agent runs, tool calls, and multi-step reasoning. |
| [AutoGen](https://traceroot.ai/docs/integrations/autogen) | Python | Automated instrumentation of multi-agent conversations, agent loops, and tool calls. |
| [Claude Agent SDK](https://traceroot.ai/docs/integrations/claude-agent-sdk) | Python, JS/TS | Automated instrumentation of agent invocations, subagent delegations, tool calls, and token usage. |
| [CrewAI](https://traceroot.ai/docs/integrations/crewai) | Python | Automated instrumentation of multi-agent collaborative workflows and task executions. |
| [DSPy](https://traceroot.ai/docs/integrations/dspy) | Python | Automated instrumentation of module executions, signature predictions, and underlying LLM calls. |
| [Google ADK](https://traceroot.ai/docs/integrations/google-adk) | Python | Automated instrumentation of agent runs, tool executions, and the multi-turn agent loop. |
| [LangChain & LangGraph](https://traceroot.ai/docs/integrations/langchain) | Python, JS/TS | Automated instrumentation by passing callback handler to LangChain application. |
| [LangChain DeepAgents](https://traceroot.ai/docs/integrations/langchain-deepagents) | Python, JS/TS | Automated instrumentation by passing callback handler to DeepAgents pipeline. |
| [LlamaIndex](https://traceroot.ai/docs/integrations/llamaindex) | Python | Automated instrumentation of RAG pipelines, document ingestion, retrieval, and LLM synthesis. |
| [Microsoft Agent Framework](https://traceroot.ai/docs/integrations/microsoft-agent-framework) | Python | Automated instrumentation of agent runs, model calls, and tool executions via Agent Framework's built-in OpenTelemetry emission. |
| [Mastra](https://traceroot.ai/docs/integrations/mastra) | JS/TS | Automated instrumentation via the TraceRoot OTLP exporter. |
| [OpenAI Agents SDK](https://traceroot.ai/docs/integrations/openai-agents-sdk) | Python, JS/TS | Automated instrumentation of agent runs, tool executions, and handoff transitions. |
| [Pydantic AI](https://traceroot.ai/docs/integrations/pydantic-ai) | Python | Automated instrumentation of agent runs, LLM calls, and tool invocations via pydantic-ai's native OpenTelemetry support. |
| [Vercel AI SDK](https://traceroot.ai/docs/integrations/vercel-ai) | JS/TS | Native OpenTelemetry tracing — no `instrumentModules` config required. AI SDK 7 needs `@ai-sdk/otel`; AI SDK 6 (legacy) uses `experimental_telemetry`. |

### Model Providers

| Integration | Supports | Description |
| ----------- | -------- | ----------- |
| [Anthropic](https://traceroot.ai/docs/integrations/anthropic) | Python, JS/TS | Automated instrumentation of the Messages API. |
| [Google Gemini](https://traceroot.ai/docs/integrations/gemini) | Python | Automated instrumentation via the Google GenAI SDK. |
| [Mistral](https://traceroot.ai/docs/integrations/mistral) | Python | Automated instrumentation of Mistral chat completions, tool calls, and streaming responses. |
| [OpenAI](https://traceroot.ai/docs/integrations/openai) | Python, JS/TS | Automated instrumentation of Chat Completions and Responses API. |
| [OpenRouter](https://traceroot.ai/docs/integrations/openrouter) | Python, JS/TS | OpenAI-compatible tracing via the OpenAI SDK base URL; see the [Python](./examples/python/openrouter-tool-agent) and [TypeScript](./examples/typescript/openrouter) examples. |

</details>

> Don't see your framework or provider? [Request an integration](https://github.com/traceroot-ai/traceroot/issues).

## TypeScript SDK Quickstart

**1. Install the SDK** in your TypeScript project:

```sh
npm install @traceroot-ai/traceroot openai
```

**2. Set your API keys:**

```bash
export TRACEROOT_API_KEY="your-project-api-key"
export TRACEROOT_HOST_URL="https://app.traceroot.ai"
export OPENAI_API_KEY="your-openai-api-key"
```

**3. Trace an agent call.** Save this as `example.ts`:

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

**4. Run it** with `npx tsx example.ts`, then open your project's **Traces** page to inspect the agent run. This example makes one OpenAI API call.

## Security & Privacy

Your data security and privacy are our top priorities. Learn more in our [Security and Privacy](SECURITY.md) documentation.

## Community

Special thanks to [pi-mono](https://github.com/badlogic/pi-mono), which powers our agent runtime.

**Contributing** 🤝: Help with code, documentation, integrations, or runnable examples. Start with the [contribution guide](CONTRIBUTING.md) and [unassigned beginner issues that do not need approval](https://github.com/traceroot-ai/traceroot/issues?q=is%3Aissue%20is%3Aopen%20label%3A%22good%20first%20issue%22%20-label%3A%22needs%20approval%22%20no%3Aassignee).

**Support** 💬: If you need any type of support, we're typically most responsive on our [Discord channel](https://discord.gg/TM2m3CtKuC), but feel free to email us `founders@traceroot.ai` too!

## License

TraceRoot uses [Apache 2.0](LICENSE) for code outside directories named `ee`. Those directories are covered by the [Enterprise License](ee/LICENSE).

## Star History

<a href="https://star-history.com/#traceroot-ai/traceroot&Date">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/svg?repos=traceroot-ai/traceroot&type=Date&theme=dark" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/svg?repos=traceroot-ai/traceroot&type=Date" />
   <img alt="Star History Chart" src="https://api.star-history.com/svg?repos=traceroot-ai/traceroot&type=Date" style="border-radius: 15px;" />
 </picture>
</a>

## Contributors

<a href="https://github.com/traceroot-ai/traceroot/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=traceroot-ai/traceroot" alt="TraceRoot contributors" />
</a>

<br>

<p align="center">⭐ <b>Star us on GitHub</b> to support TraceRoot!</p>
<p align="center"><sub>Want release updates? Select Watch → Custom → Releases.</sub></p>

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
