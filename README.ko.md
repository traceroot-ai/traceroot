<div align="center">
  <a href="https://traceroot.ai/">
    <img src="frontend/ui/public/images/traceroot_logo.png" alt="TraceRoot Logo">
  </a>

[TraceRoot]("https://traceroot.ai/")는 AI 에이전트를 위한 오픈소스 관측성 플랫폼입니다 — 트레이스를 수집하고, 프로덕션 환경의 문제를 모니터링하며, 소스 코드와 GitHub 이력을 이해하는 AI로 디버깅하세요.

  [![Y Combinator][y-combinator-image]][y-combinator-url]
  [![License][license-image]][license-url]
  [![X (Twitter)][twitter-image]][twitter-url]
  [![Discord][discord-image]][discord-url]
  [![Documentation][docs-image]][docs-url]
  [![PyPI SDK Downloads][pypi-s...mage]][pypi-s...-url]

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

| 기능 | 설명 |
| ------- | ----------- |
| 추적 | OpenTelemetry 호환 SDK를 통해 LLM 호출, 에이전트 동작, 도구 사용을 수집합니다. 중요한 트레이스를 지능적으로 드러내며, 노이즈를 걸러내고 신호를 우선합니다. |
| 에이전트 디버깅 | AI가 모든 트레이스를 확인하고, 프로덕션 소스 코드가 있는 샌드박스에 연결해 정확히 실패한 코드 줄을 찾아내며, GitHub 커밋, PR, 이슈와 실패를 연결합니다. 모든 모델 제공자를 위한 BYOK를 지원합니다. |
| 검출기(Detectors) | LLM-as-judge 평가기가 들어오는 트레이스에서 환각, 도구/로직 실패, 안전 위반, 의도 드리프트를 모니터링합니다 — 발견된 문제를 표면화하고 이메일과 Slack 알림과 함께 근본 원인 분석을 자동으로 트리거합니다. |

## 왜 TraceRoot인가요?

- **트레이스만으로는 확장하기 어렵습니다.**

  AI 에이전트 시스템이 복잡해질수록 모든 트레이스를 수동으로 훑어보는 방식은 지속 가능하지 않습니다. TraceRoot의 검출기(Detectors)는 들어오는 트레이스를 선별적으로 검사하여 — 환각, 도구 실패, 로직 오류, 안전 문제를 자동으로 표시하므로, 문제를 찾는 데가 아니라 해결하는 데 시간을 쓸 수 있습니다.

- **AI 에이전트 시스템 디버깅은 어렵습니다.**

  에이전트 환각, 도구 호출 불안정성, 버전 변경이 얽힌 실패의 근본 원인을 찾기는 어렵습니다. TraceRoot의 AI는 프로덕션 소스 코드가 실행되는 샌드박스에 연결해 정확히 실패한 코드 줄을 찾아내고, 커밋, PR, 열린 이슈 등 GitHub 이력과 대조한 뒤 수정을 위한 PR을 생성합니다.

- **완전한 오픈소스이며 벤더 종속이 없습니다.**

  관측성 플랫폼과 AI 디버깅 계층이 모두 오픈소스입니다. OpenAI, Anthropic, Gemini, xAI, DeepSeek, OpenRouter, Kimi, GLM 등 모든 모델 제공자를 위한 BYOK를 지원합니다.

## 문서

전체 문서는 [traceroot.ai/docs](https://traceroot.ai/docs)에서 확인할 수 있습니다.

## 시작하기

### TraceRoot Cloud

가장 빠르게 시작하는 방법입니다. 테스트를 위한 충분한 스토리지와 LLM 토큰을 제공하며, 신용카드가 필요 없습니다. [여기](https://app.traceroot.ai)에서 가입하세요!

### 셀프 호스팅

- 개발자 모드: 기여를 위해 TraceRoot를 로컬에서 실행합니다.

  ```bash
  # 최신 저장소 복사본 가져오기
  git clone https://github.com/traceroot-ai/traceroot.git
  cd traceroot

  # 인프라는 Docker에서 호스팅하고 앱 자체는 로컬에서 실행
  make dev
  ```
  자세한 내용은 [CONTRIBUTING.md](CONTRIBUTING.md)를 참고하세요.

- 로컬 Docker 모드: 테스트를 위해 TraceRoot를 로컬에서 실행합니다.

  ```bash
  # 최신 저장소 복사본 가져오기
  git clone https://github.com/traceroot-ai/traceroot.git
  cd traceroot

  # 모든 것을 Docker에서 호스팅
  make prod
  ```

- [Terraform (AWS)](./deploy/): Helm과 Terraform으로 k8s에서 TraceRoot를 실행합니다. 프로덕션 호스팅을 위한 방식이며 아직 실험 단계입니다.

## 통합

### 모델 제공자

| 통합 | 지원 | 설명 |
| ----------- | -------- | ----------- |
| [OpenAI](https://traceroot.ai/docs/integrations/openai) | Python, JS/TS | Chat Completions와 Responses API를 자동 계측합니다. |
| [Anthropic](https://traceroot.ai/docs/integrations/anthropic) | Python, JS/TS | Messages API를 자동 계측합니다. |
| [Google Gemini](https://traceroot.ai/docs/integrations/gemini) | Python | Google GenAI SDK를 통해 자동 계측합니다. |
| [Mistral](https://traceroot.ai/docs/integrations/mistral) | Python | Mistral 채팅 완료, 도구 호출, 스트리밍 응답을 자동 계측합니다. |

### 에이전트 프레임워크

| 통합 | 지원 | 설명 |
| ----------- | -------- | ----------- |
| [LangChain & LangGraph](https://traceroot.ai/docs/integrations/langchain) | Python, JS/TS | LangChain 애플리케이션에 콜백 핸들러를 전달해 자동 계측합니다. |
| [LangChain DeepAgents](https://traceroot.ai/docs/integrations/langchain-deepagents) | Python, JS/TS | DeepAgents 파이프라인에 콜백 핸들러를 전달해 자동 계측합니다. |
| [Claude Agent SDK](https://traceroot.ai/docs/integrations/claude-agent-sdk) | Python, JS/TS | 에이전트 호출, 서브에이전트 위임, 도구 호출, 토큰 사용량을 자동 계측합니다. |
| [OpenAI Agents SDK](https://traceroot.ai/docs/integrations/openai-agents-sdk) | Python, JS/TS | 에이전트 실행, 도구 실행, handoff 전환을 자동 계측합니다. |
| [Mastra](https://traceroot.ai/docs/integrations/mastra) | JS/TS | TraceRoot OTLP exporter를 통해 자동 계측합니다. |
| [Vercel AI SDK](https://traceroot.ai/docs/integrations/vercel-ai) | JS/TS | `experimental_telemetry`를 통한 네이티브 OpenTelemetry 추적을 지원하며 `instrumentModules` 설정이 필요 없습니다. |
| [AutoGen](https://traceroot.ai/docs/integrations/autogen) | Python | 멀티 에이전트 대화, 에이전트 루프, 도구 호출을 자동 계측합니다. |
| [LlamaIndex](https://traceroot.ai/docs/integrations/llamaindex) | Python | RAG 파이프라인, 문서 수집, 검색, LLM 합성 생성을 자동 계측합니다. |
| [CrewAI](https://traceroot.ai/docs/integrations/crewai) | Python | 멀티 에이전트 협업 워크플로와 작업 실행을 자동 계측합니다. |
| [Agno](https://traceroot.ai/docs/integrations/agno) | Python | 에이전트 실행, 도구 호출, 다단계 추론을 자동 계측합니다. |
| [DSPy](https://traceroot.ai/docs/integrations/dspy) | Python | 모듈 실행, signature 예측, 기반 LLM 호출을 자동 계측합니다. |
| [Google ADK](https://traceroot.ai/docs/integrations/google-adk) | Python | 에이전트 실행, 도구 실행, 멀티턴 에이전트 루프를 자동 계측합니다. |

> 사용하는 프레임워크나 모델 제공자가 보이지 않나요? [통합을 요청해 주세요](https://github.com/traceroot-ai/traceroot/issues).

## SDK

| 언어 | 저장소 |
| -------- | ---------- |
| Python | [traceroot-py](https://github.com/traceroot-ai/traceroot-py) |
| TypeScript | [traceroot-ts](https://github.com/traceroot-ai/traceroot-ts) |

## Python SDK 빠른 시작

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

## TypeScript SDK 빠른 시작

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

## 보안 및 개인정보 보호

데이터 보안과 개인정보 보호는 TraceRoot의 최우선 과제입니다. 자세한 내용은 [Security and Privacy](SECURITY.md) 문서를 확인하세요.

## 커뮤니티

에이전트 디버깅 런타임의 기반을 제공하는 [pi-mono](https://github.com/badlogic/pi-mono) 프로젝트에 특별히 감사드립니다!

**기여** 🤝: 기여에 관심이 있다면 [가이드](/CONTRIBUTING.md)를 확인하세요. 모든 형태의 도움을 환영합니다 :)

**지원** 💬: 도움이 필요하다면 보통 [Discord 채널](https://discord.gg/TM2m3CtKuC)에서 가장 빠르게 응답하지만, `founders@traceroot.ai`로 이메일을 보내도 됩니다!

## 라이선스

이 프로젝트는 [Apache 2.0](LICENSE) 라이선스를 따르며 추가 [Enterprise features](./ee/LICENSE)를 포함합니다.

## 기여자

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
[pypi-s...mage]: https://static.pepy.tech/badge/traceroot
[pypi-s...-url]: https://pypi.python.org/pypi/traceroot
[y-combinator-image]: https://img.shields.io/badge/Combinator-S25-orange?logo=ycombinator&labelColor=white
[y-combinator-url]: https://www.ycombinator.com/companies/traceroot-ai
[twitter-image]: https://img.shields.io/twitter/follow/TraceRootAI
[twitter-url]: https://x.com/TraceRootAI
