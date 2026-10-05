<div align="center">
  <a href="https://traceroot.ai/">
    <img src="frontend/ui/public/images/traceroot_logo.png" alt="TraceRoot Logo">
  </a>

TraceRoot 将生产环境中的追踪转化为可执行的反馈与评测，与你的编程 Agent 一起形成自我改进闭环。

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

<p align="center">⭐ 为本仓库点亮 Star，让更多开发者了解 TraceRoot，一起壮大社区！</p>

## 核心功能

### 将生产故障转化为经过验证的改进

追踪生产运行，使用检测器评估行为，并将反复出现的模式提炼为改进信号。你的编程 Agent 通过 TraceRoot CLI 分析这些信号、在本地修改代码，再通过离线评测验证改动。发布后，新的生产追踪进入下一轮检测、信号分析与验证，形成持续改进的闭环。

| 步骤 | 描述 |
| ---- | ----------- |
| **[追踪](https://traceroot.ai/docs/tracing/get-started)** | 查看每次模型调用、工具调用和响应，以及输入、输出、延迟和成本。 |
| **[检测](https://traceroot.ai/docs/detectors/get-started)** | 定义符合预期的行为，自动标记未达标准的生产运行。 |
| **信号** | 从评审输出中提炼反复出现的模式，查看相关追踪，确定需要改进的地方。 |
| **[验证](https://traceroot.ai/docs/evals/get-started)** | 基于数据集运行评测并比较版本，衡量改进效果并发现回归问题。 |

### 为你的编程 Agent 而设计

通过专为 Agent 设计的 CLI，让你的编程 Agent 读写 TraceRoot。探索追踪、信号和主页工作区；创建和更新检测器、数据集、评测、仪表盘和告警，一切都可通过编程 Agent 完成。

<p align="center">
  <a href="https://github.com/traceroot-ai/traceroot-cli">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="docs/images/coding-agent-cli-dark.png">
      <img src="docs/images/coding-agent-cli-light.png" alt="编程 Agent 通过 TraceRoot CLI 连接主页、追踪、仪表盘、检测器、评测、数据集、告警和信号。" width="100%">
    </picture>
  </a>
</p>

## ⭐ 为仓库点亮 Star

如果你喜欢我们正在构建的产品，请为 TraceRoot 点亮 Star ⭐，帮助更多开发者发现它。

<p align="center">
  <a href="https://github.com/traceroot-ai/traceroot">
    <img src="docs/images/github-star-demo.gif" alt="如何在 GitHub 上为 TraceRoot 仓库点亮 Star" width="100%">
  </a>
</p>

## 开始使用 TraceRoot

### TraceRoot Cloud

[创建账号](https://app.traceroot.ai)，无需自行部署即可开始使用。

### 自托管

安装 Git、Docker Compose 和 Make 后，在本地运行：

```bash
git clone https://github.com/traceroot-ai/traceroot.git
cd traceroot
cp .env.example .env
make prod-lite
```

打开 [localhost:3000](http://localhost:3000)。配置与部署详情请参阅[自托管指南](https://traceroot.ai/docs/developer/self-hosting)。

## 配置 TraceRoot

准备好 TraceRoot 实例后，在仪表盘中创建项目，并选择发送第一条追踪的方式：让编程 Agent 通过 CLI 配置埋点，或手动配置 SDK。

### 使用编程 Agent

<a id="cli-quickstart"></a>

安装 [TraceRoot CLI](https://github.com/traceroot-ai/traceroot-cli#readme) 并登录：

```bash
npm install -g traceroot-cli
traceroot login
```

然后向你的编程 Agent 提出请求：

```text
使用 TraceRoot CLI 为此应用配置追踪。
安装适用的 TraceRoot 技能，指导我完成必要的配置，
并确认第一条追踪已出现在 TraceRoot 中。
```

### 手动配置 SDK

想自己配置埋点？使用 **[Python SDK](https://github.com/traceroot-ai/traceroot-py#readme)** 或 **[TypeScript SDK](https://github.com/traceroot-ai/traceroot-ts#readme)**。以下示例从 TypeScript 应用发送一次带追踪的模型调用。

<details>
<summary>运行最小 TypeScript 示例</summary>

你需要 Node.js、npm、TraceRoot 项目 API 密钥和 OpenAI API 密钥。自托管时，请将下方的云服务地址替换为你的实例地址。

**1. 安装 SDK**，在 TypeScript 项目中运行：

```sh
npm install @traceroot-ai/traceroot openai
```

**2. 设置 API 密钥：**

```bash
export TRACEROOT_API_KEY="your-project-api-key"
export TRACEROOT_HOST_URL="https://app.traceroot.ai"
export OPENAI_API_KEY="your-openai-api-key"
```

**3. 追踪一次 Agent 调用。** 将以下代码保存为 `example.ts`：

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

**4. 运行** `npx tsx example.ts`，然后打开项目的 **Traces** 页面查看 Agent 运行记录。此示例会发起一次 OpenAI API 调用。

</details>

## 集成

### 原生 SDK

| 语言 | 仓库 |
| -------- | ---------- |
| Python | [traceroot-py](https://github.com/traceroot-ai/traceroot-py) |
| TypeScript | [traceroot-ts](https://github.com/traceroot-ai/traceroot-ts) |

<details open>
<summary>支持的框架与模型厂商</summary>

### Agent 框架

| 集成 | 支持语言 | 描述 |
| ----------- | -------- | ----------- |
| [Agno](https://traceroot.ai/docs/integrations/agno) | Python | 自动埋点 Agent 运行、工具调用以及多步推理。 |
| [AutoGen](https://traceroot.ai/docs/integrations/autogen) | Python | 自动埋点多 Agent 对话、Agent 循环以及工具调用。 |
| [Claude Agent SDK](https://traceroot.ai/docs/integrations/claude-agent-sdk) | Python, JS/TS | 自动埋点 Agent 调用、子 Agent 委派、工具调用以及 token 用量。 |
| [CrewAI](https://traceroot.ai/docs/integrations/crewai) | Python | 自动埋点多 Agent 协作流程以及任务执行。 |
| [DSPy](https://traceroot.ai/docs/integrations/dspy) | Python | 自动埋点模块执行、signature 预测以及底层 LLM 调用。 |
| [Google ADK](https://traceroot.ai/docs/integrations/google-adk) | Python | 自动埋点 Agent 运行、工具执行以及多轮 Agent 循环。 |
| [LangChain & LangGraph](https://traceroot.ai/docs/integrations/langchain) | Python, JS/TS | 将 callback handler 传入 LangChain 应用即可自动埋点。 |
| [LangChain DeepAgents](https://traceroot.ai/docs/integrations/langchain-deepagents) | Python, JS/TS | 将 callback handler 传入 DeepAgents 流水线即可自动埋点。 |
| [LlamaIndex](https://traceroot.ai/docs/integrations/llamaindex) | Python | 自动埋点 RAG 流水线、文档摄取、检索以及 LLM 综合生成。 |
| [Microsoft Agent Framework](https://traceroot.ai/docs/integrations/microsoft-agent-framework) | Python | 通过 Agent Framework 内置的 OpenTelemetry 自动埋点 Agent 运行、模型调用以及工具执行。 |
| [Mastra](https://traceroot.ai/docs/integrations/mastra) | JS/TS | 通过 TraceRoot OTLP exporter 自动埋点。 |
| [OpenAI Agents SDK](https://traceroot.ai/docs/integrations/openai-agents-sdk) | Python, JS/TS | 自动埋点 Agent 运行、工具执行以及 handoff 流转。 |
| [Pydantic AI](https://traceroot.ai/docs/integrations/pydantic-ai) | Python | 通过 pydantic-ai 原生 OpenTelemetry 支持，自动埋点 Agent 运行、LLM 调用以及工具调用。 |
| [Vercel AI SDK](https://traceroot.ai/docs/integrations/vercel-ai) | JS/TS | 原生 OpenTelemetry 追踪，无需配置 `instrumentModules`。AI SDK 7 需要 `@ai-sdk/otel`，AI SDK 6（旧版）使用 `experimental_telemetry`。 |

### 模型厂商

| 集成 | 支持语言 | 描述 |
| ----------- | -------- | ----------- |
| [Anthropic](https://traceroot.ai/docs/integrations/anthropic) | Python, JS/TS | 自动埋点 Messages API。 |
| [Google Gemini](https://traceroot.ai/docs/integrations/gemini) | Python | 通过 Google GenAI SDK 实现自动埋点。 |
| [Mistral](https://traceroot.ai/docs/integrations/mistral) | Python | 自动埋点 Mistral 的 chat completions、工具调用以及流式响应。 |
| [OpenAI](https://traceroot.ai/docs/integrations/openai) | Python, JS/TS | 自动埋点 Chat Completions 与 Responses API。 |
| [OpenRouter](https://traceroot.ai/docs/integrations/openrouter) | Python, JS/TS | 通过 OpenAI SDK 的 OpenRouter base URL 进行兼容追踪；可参考 [Python](./examples/python/openrouter-tool-agent) 与 [TypeScript](./examples/typescript/openrouter) 示例。 |

</details>

> 没有看到你使用的框架或模型厂商？欢迎[提交集成请求](https://github.com/traceroot-ai/traceroot/issues)。

## 安全与隐私

我们高度重视用户的数据安全与隐私。详情请见我们的[安全与隐私](SECURITY.md)文档。

## 社区

特别感谢 [pi-mono](https://github.com/badlogic/pi-mono)，它为我们的 Agent 运行时提供支持。

**参与贡献** 🤝：欢迎贡献代码、文档、集成或可运行的示例。从[贡献指南](CONTRIBUTING.md)和[尚未分配且无需审批的新手任务](https://github.com/traceroot-ai/traceroot/issues?q=is%3Aissue%20is%3Aopen%20label%3A%22good%20first%20issue%22%20-label%3A%22needs%20approval%22%20no%3Aassignee)开始。

**寻求支持** 💬：如果你需要任何形式的支持，我们在 [Discord 频道](https://discord.gg/TM2m3CtKuC) 通常响应最快，也欢迎给我们发邮件 `founders@traceroot.ai`！

## 许可证

TraceRoot 中除名为 `ee` 的目录外，代码均采用 [Apache 2.0](LICENSE) 许可证。`ee` 目录中的代码采用[企业版许可证](ee/LICENSE)。

## Star 趋势

<p align="center">
<a href="https://star-history.com/#traceroot-ai/traceroot&Date">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/svg?repos=traceroot-ai/traceroot&type=Date&theme=dark" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/svg?repos=traceroot-ai/traceroot&type=Date" />
   <img alt="Star History Chart" src="https://api.star-history.com/svg?repos=traceroot-ai/traceroot&type=Date" style="border-radius: 15px;" />
 </picture>
</a>
</p>

## 贡献者

<p align="center">
<a href="https://github.com/traceroot-ai/traceroot/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=traceroot-ai/traceroot" alt="TraceRoot 贡献者" />
</a>
</p>

<br>

<p align="center">⭐ <b>在 GitHub 上给我们点个 Star</b>，支持 TraceRoot！</p>

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
