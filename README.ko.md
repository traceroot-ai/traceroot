<div align="center">
  <a href="https://traceroot.ai/">
    <img src="frontend/ui/public/images/traceroot_logo.png" alt="TraceRoot Logo">
  </a>

[TraceRoot]("https://traceroot.ai/")는 AI 에이전트를 위한 오픈소스 옵저버빌리티 플랫폼입니다 — 트레이스 수집, 프로덕션 이슈 모니터링, 그리고 소스 코드 및 GitHub 히스토리를 이해하는 AI 기반 디버깅 기능을 제공합니다.

  [![Y Combinator][y-combinator-image]][y-combinator-url]
  [![License][license-image]][license-url]
  [![X (Twitter)][twitter-image]][twitter-url]
  [![Discord][discord-image]][discord-url]
  [![Documentation][docs-image]][docs-url]
  [![PyPI SDK Downloads][pypi-sdk-downloads-image]][pypi-sdk-downloads-url]

</div>

<p align="center">
  <a href="./README.md"><img alt="README in English" src="https://img.shields.io/badge/English-f8f8f8"></a>
  <a href="./README.zh.md"><img alt="简体中文版自述文件" src="https://img.shields.io/badge/简体中文-f8f8f8"></a>
  <a href="./README.ko.md"><img alt="한국어 README" src="https://img.shields.io/badge/한국어-f8f8f8"></a>
</p>

## 기능

<div align="center">
  <kbd><img src="docs/images/rca_v1.png" alt="에이전트 디버깅 - 근본 원인 분석"></kbd>
</div>

<br>

| Feature | 설명 |
| ------- | ----------- |
| Tracing | OpenTelemetry 호환 SDK를 통해 LLM 호출, 에이전트 액션, 툴 사용 내역을 수집합니다. 노이즈는 제거하고 중요한 시그널 중심으로 트레이스를 제공합니다. |
| Agentic Debugging | 모든 트레이스를 이해하는 AI가 프로덕션 소스 코드가 연결된 샌드박스에서 정확한 실패 지점을 식별하고, GitHub 커밋·PR·이슈와 연관 분석합니다. 모든 모델 프로바이더에 대해 BYOK를 지원합니다. |
| Detectors | LLM-as-a-Judge evaluator가 hallucination, 툴/로직 실패, 안전성 위반, intent drift를 모니터링합니다. 이상 징후를 탐지하고 이메일 및 Slack 알림과 함께 root cause analysis를 자동 수행합니다. |

## Why TraceRoot?

- **트레이스만으로는 확장성이 없습니다.**

  AI 에이전트 시스템이 복잡해질수록 모든 트레이스를 사람이 직접 분석하는 방식은 한계가 있습니다. TraceRoot의 Detectors는 유입되는 트레이스를 선별적으로 분석해 hallucination, 툴 실패, 로직 오류, 안전성 이슈를 자동으로 탐지합니다. 문제를 찾는 데 시간을 쓰는 대신, 문제를 해결하는 데 집중할 수 있습니다.

- **AI 에이전트 디버깅은 어렵습니다.**

  Hallucination, 툴 호출 불안정성, 버전 변경 등 다양한 원인으로 발생하는 장애의 root cause를 추적하는 일은 쉽지 않습니다. TraceRoot의 AI는 프로덕션 소스 코드가 실행되는 샌드박스에 연결되어 정확한 실패 지점을 식별하고, GitHub 커밋·PR·오픈 이슈와 교차 분석해 수정용 PR까지 생성합니다.

- **완전한 오픈소스. 벤더 락인 없음.**

  옵저버빌리티 플랫폼과 AI 디버깅 레이어 모두 오픈소스로 제공됩니다. OpenAI, Anthropic, Gemini, xAI, DeepSeek, OpenRouter, Kimi, GLM 등 모든 모델 프로바이더에 대해 BYOK를 지원합니다.

## 문서

전체 문서는 [traceroot.ai/docs](https://traceroot.ai/docs)에서 확인할 수 있습니다.

## Getting Started

### TraceRoot Cloud

가장 빠르게 시작할 수 있는 방법입니다. 테스트용 스토리지와 LLM 토큰을 충분히 제공하며, 신용카드 등록 없이 바로 사용할 수 있습니다. [여기](https://app.traceroot.ai)에서 가입하세요.

### Self Hosting

- 개발자 모드: 로컬 환경에서 TraceRoot를 실행하고 개발 및 기여할 수 있습니다.

  ```bash
  # 최신 레포 클론
  git clone https://github.com/traceroot-ai/traceroot.git
  cd traceroot

  # 인프라는 Docker로 실행하고 앱은 로컬에서 실행
  make dev
  ```
  자세한 내용은 [CONTRIBUTING.md](CONTRIBUTING.md)를 참고하세요.

- 로컬 Docker 모드: 테스트용으로 TraceRoot 전체를 로컬 Docker 환경에서 실행합니다.

  ```bash
  # 최신 레포 클론
  git clone https://github.com/traceroot-ai/traceroot.git
  cd traceroot

  # 전체 서비스를 Docker로 실행
  make prod
  ```

- [Terraform (AWS)](./deploy/): Helm과 Terraform으로 Kubernetes 환경에 TraceRoot를 배포합니다. 프로덕션 호스팅용이며, 현재는 experimental 단계입니다.

## 통합

### 모델 프로바이더

| Integration | 지원 언어 | 설명 |
| ----------- | -------- | ----------- |
| [OpenAI](https://traceroot.ai/docs/integrations/openai) | Python, JS/TS | Chat Completions 및 Responses API에 대한 instrumentation을 자동으로 수집합니다. |
| [Anthropic](https://traceroot.ai/docs/integrations/anthropic) | Python, JS/TS | Messages API에 대한 instrumentation을 자동으로 수집합니다. |
| [Google Gemini](https://traceroot.ai/docs/integrations/gemini) | Python | Google GenAI SDK 기반 instrumentation을 자동으로 수집합니다. |
| [Mistral](https://traceroot.ai/docs/integrations/mistral) | Python | Mistral chat completions, 툴 호출, streaming response에 대한 instrumentation을 자동으로 수집합니다. |

### 에이전트 프레임워크

| Integration | 지원 언어 | 설명 |
| ----------- | -------- | ----------- |
| [LangChain & LangGraph](https://traceroot.ai/docs/integrations/langchain) | Python, JS/TS | callback handler를 LangChain 애플리케이션에 전달해 instrumentation을 자동으로 수집합니다. |
| [LangChain DeepAgents](https://traceroot.ai/docs/integrations/langchain-deepagents) | Python, JS/TS | callback handler를 DeepAgents 파이프라인에 전달해 instrumentation을 자동으로 수집합니다. |
| [Claude Agent SDK](https://traceroot.ai/docs/integrations/claude-agent-sdk) | Python, JS/TS | 에이전트 호출, subagent delegation, 툴 호출, 토큰 사용량에 대한 instrumentation을 자동으로 수집합니다. |
| [OpenAI Agents SDK](https://traceroot.ai/docs/integrations/openai-agents-sdk) | 에이전트 실행, 툴 실행, handoff transition에 대한 instrumentation을 자동으로 수집합니다. |
| [Mastra](https://traceroot.ai/docs/integrations/mastra) | JS/TS | TraceRoot OTLP exporter를 통한 자동 instrumentation을 지원합니다. |
| [Vercel AI SDK](https://traceroot.ai/docs/integrations/vercel-ai) | JS/TS | `experimental_telemetry` 기반의 네이티브 OpenTelemetry tracing을 지원합니다. 별도의 `instrumentModules` 설정이 필요하지 않습니다. |
| [AutoGen](https://traceroot.ai/docs/integrations/autogen) | Python | 멀티 에이전트 대화, agent loop, 툴 호출에 대한 instrumentation을 자동으로 수집합니다. |
| [LlamaIndex](https://traceroot.ai/docs/integrations/llamaindex) | Python | RAG 파이프라인, 문서 ingestion, retrieval, LLM synthesis에 대한 instrumentation을 자동으로 수집합니다. |
| [CrewAI](https://traceroot.ai/docs/integrations/crewai) | Python | 멀티 에이전트 협업 워크플로우 및 task execution에 대한 instrumentation을 자동으로 수집합니다. |
| [Agno](https://traceroot.ai/docs/integrations/agno) | Python | 에이전트 실행, 툴 호출, multi-step reasoning에 대한 instrumentation을 자동으로 수집합니다. |
| [DSPy](https://traceroot.ai/docs/integrations/dspy) | Python | 모듈 실행, signature prediction, 내부 LLM 호출에 대한 instrumentation을 자동으로 수집합니다. |
| [Google ADK](https://traceroot.ai/docs/integrations/google-adk) | Python | 에이전트 실행, 툴 실행, multi-turn agent loop에 대한 instrumentation을 자동으로 수집합니다. |

> 프레임워크나 프로바이더가 목록에 없나요? [Integration 요청을 보내주세요](https://github.com/traceroot-ai/traceroot/issues).

## SDK

| 언어 | 레포지토리 |
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

데이터 보안과 프라이버시는 최우선 가치입니다. 자세한 내용은 [Security and Privacy](SECURITY.md) 문서를 참고하세요.

## Community

Agentic Debugging Runtime의 기반을 제공하는 [pi-mono](https://github.com/badlogic/pi-mono) 프로젝트에 감사드립니다.

**Contributing** 🤝: 기여하는데에 관심이 있다면 [Contribution 가이드](/CONTRIBUTING.md)를 참고해주세요. 어떠한 형태로든 도움주시는건 환영입니다 :)

**Support** 💬: 지원이 필요하다면 [Discord 채널](https://discord.gg/TM2m3CtKuC)에서 가장 빠르게 응답받을 수 있습니다. `founders@traceroot.ai`로 이메일을 보내주셔도 됩니다.

## License

이 프로젝트는 [Apache 2.0 라이선스](LICENSE)를 기반으로 제공되며, 추가 [Enterprise 기능](./ee/LICENSE)을 포함합니다.

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
