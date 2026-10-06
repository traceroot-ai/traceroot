<div align="center">
  <a href="https://traceroot.ai/">
    <img src="frontend/ui/public/images/traceroot_logo.png" alt="TraceRoot Logo">
  </a>

AI 에이전트를 위한 오픈 소스 자기 개선 레이어

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

<p align="center">⭐ 더 많은 개발자에게 TraceRoot를 알리고 커뮤니티를 키울 수 있도록 이 저장소에 Star를 남겨 주세요!</p>

## TraceRoot

TraceRoot는 프로덕션 트레이스를 실행 가능한 피드백과 평가로 전환하고, 코딩 에이전트와 함께 자기 개선 루프를 완성합니다.

https://github.com/user-attachments/assets/4615970f-812c-4c8d-9c26-139eb89023cb

## 핵심 기능

### 프로덕션 실패를 검증된 개선으로 전환하세요

프로덕션 실행을 추적하고, 탐지기로 동작을 평가하며, 반복되는 패턴을 개선 신호로 도출합니다. 코딩 에이전트는 TraceRoot CLI로 신호를 분석하고 로컬에서 코드를 수정한 뒤 오프라인 평가로 변경 사항을 검증합니다. 배포 후에는 새로운 프로덕션 트레이스가 다음 탐지, 신호 분석, 검증으로 이어져 지속적인 개선 루프를 이룹니다.

| 단계 | 설명 |
| ---- | ----------- |
| **[추적](https://traceroot.ai/docs/tracing/get-started)** | 각 모델 호출, 도구 호출, 응답과 함께 입력, 출력, 지연 시간, 비용을 확인하세요. |
| **[탐지](https://traceroot.ai/docs/detectors/get-started)** | 기대하는 동작을 정의하고, 기준에 미치지 못하는 프로덕션 실행을 자동으로 표시하세요. |
| **신호** | 평가 모델의 출력에서 반복되는 패턴을 찾고, 관련 트레이스를 검토해 무엇을 바꿀지 파악하세요. |
| **[검증](https://traceroot.ai/docs/evals/get-started)** | 데이터셋으로 평가를 실행하고 버전을 비교해 개선 효과를 측정하고 회귀를 발견하세요. |

### 코딩 에이전트를 위한 설계

에이전트에 맞춰 설계된 CLI로 코딩 에이전트가 TraceRoot를 읽고 쓸 수 있게 하세요. 트레이스, 신호, 홈 작업 공간을 탐색하고 탐지기, 데이터셋, 평가, 대시보드, 알림을 생성하고 수정하는 작업을 모두 코딩 에이전트에서 수행할 수 있습니다.

<p align="center">
  <a href="https://github.com/traceroot-ai/traceroot-cli">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="docs/images/coding-agent-cli-dark.png">
      <img src="docs/images/coding-agent-cli-light.png" alt="코딩 에이전트가 TraceRoot CLI를 통해 홈, 트레이스, 대시보드, 탐지기, 평가, 데이터셋, 알림, 신호에 연결됩니다." width="100%">
    </picture>
  </a>
</p>

## ⭐ 저장소에 Star를 남겨 주세요

TraceRoot가 마음에 드신다면 Star ⭐를 남겨 더 많은 개발자가 발견할 수 있도록 도와주세요.

<p align="center">
  <a href="https://github.com/traceroot-ai/traceroot">
    <img src="docs/images/github-star-demo.gif" alt="GitHub에서 TraceRoot 저장소에 Star를 남기는 방법" width="100%">
  </a>
</p>

## TraceRoot 시작하기

### TraceRoot Cloud

[계정을 만들고](https://app.traceroot.ai) 직접 플랫폼을 운영할 필요 없이 시작하세요.

### 셀프 호스팅

Git, Docker Compose, Make를 설치한 뒤 로컬에서 실행하세요:

```bash
git clone https://github.com/traceroot-ai/traceroot.git
cd traceroot
cp .env.example .env
make prod-lite
```

[localhost:3000](http://localhost:3000)을 여세요. 설정과 배포에 관한 자세한 내용은 [셀프 호스팅 가이드](https://traceroot.ai/docs/developer/self-hosting)를 참고하세요.

## TraceRoot 설정하기

TraceRoot 인스턴스가 준비되면 대시보드에서 프로젝트를 만들고 첫 트레이스를 전송할 방법을 선택하세요. 코딩 에이전트가 CLI로 계측을 설정하도록 하거나 SDK를 직접 설정할 수 있습니다.

### 코딩 에이전트로 설정하기

<a id="cli-quickstart"></a>

[TraceRoot CLI](https://github.com/traceroot-ai/traceroot-cli#readme)를 설치하고 로그인하세요:

```bash
npm install -g traceroot-cli
traceroot login
```

그런 다음 코딩 에이전트에게 요청하세요:

```text
TraceRoot CLI로 이 애플리케이션에 트레이싱을 설정해 주세요.
적절한 TraceRoot 스킬을 설치하고 필요한 설정을 안내한 뒤,
첫 트레이스가 TraceRoot에 표시되는지 확인해 주세요.
```

### SDK로 직접 설정하기

직접 계측을 설정하고 싶으신가요? **[Python SDK](https://github.com/traceroot-ai/traceroot-py#readme)** 또는 **[TypeScript SDK](https://github.com/traceroot-ai/traceroot-ts#readme)**를 사용하세요. 아래 예제는 TypeScript 애플리케이션에서 모델 호출 한 건의 트레이스를 전송합니다.

<details>
<summary>최소 TypeScript 예제 실행하기</summary>

Node.js와 npm, TraceRoot 프로젝트 API 키, OpenAI API 키가 필요합니다. 셀프 호스팅을 사용하는 경우 아래 클라우드 호스트 URL을 인스턴스 URL로 바꾸세요.

**1. SDK 설치:** TypeScript 프로젝트에서 실행하세요:

```sh
npm install @traceroot-ai/traceroot openai
```

**2. API 키 설정:**

```bash
export TRACEROOT_API_KEY="your-project-api-key"
export TRACEROOT_HOST_URL="https://app.traceroot.ai"
export OPENAI_API_KEY="your-openai-api-key"
```

**3. 에이전트 호출 추적:** 다음 코드를 `example.ts`로 저장하세요:

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

**4. 실행:** `npx tsx example.ts`를 실행한 뒤 프로젝트의 **Traces** 페이지에서 에이전트 실행을 확인하세요. 이 예제는 OpenAI API를 한 번 호출합니다.

</details>

## 통합

### 네이티브 SDK

| 언어 | 저장소 |
| -------- | ---------- |
| Python | [traceroot-py](https://github.com/traceroot-ai/traceroot-py) |
| TypeScript | [traceroot-ts](https://github.com/traceroot-ai/traceroot-ts) |

<details open>
<summary>지원하는 프레임워크 및 모델 프로바이더</summary>

### 에이전트 프레임워크

| 통합 | 지원 언어 | 설명 |
| ----------- | -------- | ----------- |
| [Agno](https://traceroot.ai/docs/integrations/agno) | Python | 에이전트 실행, 툴 호출, multi-step reasoning에 대한 instrumentation을 자동으로 수집합니다. |
| [AutoGen](https://traceroot.ai/docs/integrations/autogen) | Python | 멀티 에이전트 대화, agent loop, 툴 호출에 대한 instrumentation을 자동으로 수집합니다. |
| [Claude Agent SDK](https://traceroot.ai/docs/integrations/claude-agent-sdk) | Python, JS/TS | 에이전트 호출, subagent delegation, 툴 호출, 토큰 사용량에 대한 instrumentation을 자동으로 수집합니다. |
| [CrewAI](https://traceroot.ai/docs/integrations/crewai) | Python | 멀티 에이전트 협업 워크플로우 및 task execution에 대한 instrumentation을 자동으로 수집합니다. |
| [DSPy](https://traceroot.ai/docs/integrations/dspy) | Python | 모듈 실행, signature prediction, 내부 LLM 호출에 대한 instrumentation을 자동으로 수집합니다. |
| [Google ADK](https://traceroot.ai/docs/integrations/google-adk) | Python | 에이전트 실행, 툴 실행, multi-turn agent loop에 대한 instrumentation을 자동으로 수집합니다. |
| [LangChain & LangGraph](https://traceroot.ai/docs/integrations/langchain) | Python, JS/TS | callback handler를 LangChain 애플리케이션에 전달해 instrumentation을 자동으로 수집합니다. |
| [LangChain DeepAgents](https://traceroot.ai/docs/integrations/langchain-deepagents) | Python, JS/TS | callback handler를 DeepAgents 파이프라인에 전달해 instrumentation을 자동으로 수집합니다. |
| [LlamaIndex](https://traceroot.ai/docs/integrations/llamaindex) | Python | RAG 파이프라인, 문서 ingestion, retrieval, LLM synthesis에 대한 instrumentation을 자동으로 수집합니다. |
| [Microsoft Agent Framework](https://traceroot.ai/docs/integrations/microsoft-agent-framework) | Python | Agent Framework의 내장 OpenTelemetry를 통해 agent 실행, 모델 호출, 툴 실행에 대한 instrumentation을 자동으로 수집합니다. |
| [Mastra](https://traceroot.ai/docs/integrations/mastra) | JS/TS | TraceRoot OTLP exporter를 통한 자동 instrumentation을 지원합니다. |
| [OpenAI Agents SDK](https://traceroot.ai/docs/integrations/openai-agents-sdk) | Python, JS/TS | 에이전트 실행, 툴 실행, handoff transition에 대한 instrumentation을 자동으로 수집합니다. |
| [Pydantic AI](https://traceroot.ai/docs/integrations/pydantic-ai) | Python | pydantic-ai의 네이티브 OpenTelemetry 지원을 통해 에이전트 실행, LLM 호출, 툴 호출에 대한 instrumentation을 자동으로 수집합니다. |
| [Vercel AI SDK](https://traceroot.ai/docs/integrations/vercel-ai) | JS/TS | 네이티브 OpenTelemetry tracing을 지원합니다. 별도의 `instrumentModules` 설정이 필요하지 않습니다. AI SDK 7은 `@ai-sdk/otel`이 필요하고, AI SDK 6(레거시)은 `experimental_telemetry`를 사용합니다. |

### 모델 프로바이더

| 통합 | 지원 언어 | 설명 |
| ----------- | -------- | ----------- |
| [Anthropic](https://traceroot.ai/docs/integrations/anthropic) | Python, JS/TS | Messages API에 대한 instrumentation을 자동으로 수집합니다. |
| [Google Gemini](https://traceroot.ai/docs/integrations/gemini) | Python | Google GenAI SDK 기반 instrumentation을 자동으로 수집합니다. |
| [Mistral](https://traceroot.ai/docs/integrations/mistral) | Python | Mistral chat completions, 툴 호출, streaming response에 대한 instrumentation을 자동으로 수집합니다. |
| [OpenAI](https://traceroot.ai/docs/integrations/openai) | Python, JS/TS | Chat Completions 및 Responses API에 대한 instrumentation을 자동으로 수집합니다. |
| [OpenRouter](https://traceroot.ai/docs/integrations/openrouter) | Python, JS/TS | OpenAI SDK의 OpenRouter base URL로 호환 tracing을 수집합니다. [Python](./examples/python/openrouter-tool-agent) 및 [TypeScript](./examples/typescript/openrouter) 예제를 참고하세요. |

</details>

> 사용하는 프레임워크나 프로바이더가 없나요? [통합을 요청해주세요](https://github.com/traceroot-ai/traceroot/issues).

## Security & Privacy

데이터 보안과 프라이버시는 최우선 가치입니다. 자세한 내용은 [Security and Privacy](SECURITY.md) 문서를 참고하세요.

## Community

에이전트 런타임의 기반을 제공하는 [pi-mono](https://github.com/badlogic/pi-mono)에 감사드립니다.

**기여하기** 🤝: 코드, 문서, 통합, 실행 가능한 예제로 기여할 수 있습니다. [기여 가이드](CONTRIBUTING.md)와 [담당자가 없고 승인이 필요하지 않은 초보자용 이슈](https://github.com/traceroot-ai/traceroot/issues?q=is%3Aissue%20is%3Aopen%20label%3A%22good%20first%20issue%22%20-label%3A%22needs%20approval%22%20no%3Aassignee)부터 살펴보세요.

**Support** 💬: 지원이 필요하다면 [Discord 채널](https://discord.gg/TM2m3CtKuC)에서 가장 빠르게 응답받을 수 있습니다. `founders@traceroot.ai`로 이메일을 보내주셔도 됩니다.

## License

TraceRoot는 `ee` 디렉터리 외부의 코드에 [Apache 2.0](LICENSE) 라이선스를 적용합니다. `ee` 디렉터리에는 [Enterprise 라이선스](ee/LICENSE)가 적용됩니다.

## Star History

<p align="center">
<a href="https://star-history.com/#traceroot-ai/traceroot&Date">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/svg?repos=traceroot-ai/traceroot&type=Date&theme=dark" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/svg?repos=traceroot-ai/traceroot&type=Date" />
   <img alt="Star History Chart" src="https://api.star-history.com/svg?repos=traceroot-ai/traceroot&type=Date" style="border-radius: 15px;" />
 </picture>
</a>
</p>

## Contributors

<p align="center">
<a href="https://github.com/traceroot-ai/traceroot/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=traceroot-ai/traceroot" alt="TraceRoot 기여자" />
</a>
</p>

<br>

<p align="center">⭐ <b>GitHub에서 Star를 눌러</b> TraceRoot를 응원해 주세요!</p>

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
