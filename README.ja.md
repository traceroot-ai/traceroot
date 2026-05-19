<div align="center">
  <a href="https://traceroot.ai/">
    <img src="frontend/ui/public/images/traceroot_logo.png" alt="TraceRoot Logo">
  </a>

[TraceRoot]("https://traceroot.ai/") は、AI エージェント向けのオープンソース可観測性プラットフォームです — トレースをキャプチャし、ソースコードと GitHub 履歴を把握する AI でデバッグできます。

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
  <a href="./README.ja.md"><img alt="日本語版 README" src="https://img.shields.io/badge/日本語-f8f8f8"></a>
</p>

## 機能

<div align="center">
  <kbd><img src="docs/images/rca_v1.png" alt="Agentic Debugging - Root Cause Analysis"></kbd>
</div>

<br>

| 機能 | 説明 |
| ---- | ---- |
| トレーシング | OpenTelemetry 互換 SDK を通じて、LLM 呼び出し、エージェントのアクション、ツール利用をキャプチャします。重要なトレースをインテリジェントに浮上させます — ノイズを除去し、シグナルを優先します。 |
| エージェント型デバッグ | すべてのトレースを把握し、本番ソースコードを含むサンドボックスに接続し、正確な失敗行を特定し、その失敗を GitHub のコミット、PR、Issue と関連付ける AI です。任意のモデルプロバイダーに対する BYOK をサポートします。 |

## なぜ TraceRoot なのか？

- **トレースだけではスケールしません。**

  AI エージェントシステムが複雑になるにつれ、すべてのトレースを手作業で調べることは持続可能ではありません。TraceRoot はトレースを選択的にスクリーニングし、ノイズを除去して、本当に注意が必要なものだけを浮上させます。これにより、問題探しではなく、問題の修正に時間を使えます。

- **AI エージェントシステムのデバッグは大変です。**

  エージェントのハルシネーション、ツール呼び出しの不安定性、バージョン変更にまたがる障害の根本原因を突き止めるのは困難です。TraceRoot の AI は、本番ソースコードを実行するサンドボックスに接続し、正確な失敗行を特定し、GitHub 履歴 — コミット、PR、未解決 Issue — と照合し、それを修正する PR を作成します。

- **完全にオープンソースで、ベンダーロックインはありません。**

  可観測性プラットフォームと AI デバッグレイヤーの両方がオープンソースです。任意のモデルプロバイダー — OpenAI、Anthropic、Gemini、xAI、DeepSeek、OpenRouter、Kimi、GLM など — に対する BYOK をサポートします。

## ドキュメント

完全なドキュメントは [traceroot.ai/docs](https://traceroot.ai/docs) で公開されています。

## はじめに

### TraceRoot Cloud

始めるための最速の方法です。テスト用に十分なストレージと LLM トークンが用意されており、クレジットカードは不要です。[こちら](https://app.traceroot.ai) から登録してください！

### セルフホスティング

- 開発者モード: コントリビュートするために TraceRoot をローカルで実行します。

  ```bash
  # Get a copy of the latest repo
  git clone https://github.com/traceroot-ai/traceroot.git
  cd traceroot

  # Hosted the infras in docker and app itself locally
  make dev
  ```
  詳細については、[CONTRIBUTING.md](CONTRIBUTING.md) を参照してください。

- ローカル Docker モード: テストのために TraceRoot をローカルで実行します。

  ```bash
  # Get a copy of the latest repo
  git clone https://github.com/traceroot-ai/traceroot.git
  cd traceroot

  # Hosted everything in docker
  make prod
  ```

- [Terraform (AWS)](./deploy/): Helm と Terraform を使用して k8s 上で TraceRoot を実行します。本番ホスティング向けです。まだ実験段階です。

## インテグレーション

### モデルプロバイダー

| インテグレーション | 対応言語 | 説明 |
| ------------------ | -------- | ---- |
| [OpenAI](https://traceroot.ai/docs/integrations/openai) | Python, JS/TS | Chat Completions と Responses API の自動インストルメンテーション。 |
| [Anthropic](https://traceroot.ai/docs/integrations/anthropic) | Python, JS/TS | Messages API の自動インストルメンテーション。 |
| [Google Gemini](https://traceroot.ai/docs/integrations/gemini) | Python | Google GenAI SDK による自動インストルメンテーション。 |
| [Mistral](https://traceroot.ai/docs/integrations/mistral) | Python | Mistral のチャット補完、ツール呼び出し、ストリーミングレスポンスの自動インストルメンテーション。 |

### エージェントフレームワーク

| インテグレーション | 対応言語 | 説明 |
| ------------------ | -------- | ---- |
| [LangChain & LangGraph](https://traceroot.ai/docs/integrations/langchain) | Python, JS/TS | LangChain アプリケーションに callback handler を渡すことによる自動インストルメンテーション。 |
| [LangChain DeepAgents](https://traceroot.ai/docs/integrations/langchain-deepagents) | Python, JS/TS | DeepAgents パイプラインに callback handler を渡すことによる自動インストルメンテーション。 |
| [Claude Agent SDK](https://traceroot.ai/docs/integrations/claude-agent-sdk) | Python, JS/TS | エージェント呼び出し、サブエージェント委任、ツール呼び出し、トークン使用量の自動インストルメンテーション。 |
| [OpenAI Agents SDK](https://traceroot.ai/docs/integrations/openai-agents-sdk) | Python, JS/TS | エージェント実行、ツール実行、ハンドオフ遷移の自動インストルメンテーション。 |
| [Mastra](https://traceroot.ai/docs/integrations/mastra) | JS/TS | TraceRoot OTLP exporter による自動インストルメンテーション。 |
| [Vercel AI SDK](https://traceroot.ai/docs/integrations/vercel-ai) | JS/TS | `experimental_telemetry` によるネイティブ OpenTelemetry トレーシング — `instrumentModules` 設定は不要です。 |
| [AutoGen](https://traceroot.ai/docs/integrations/autogen) | Python | マルチエージェント会話、エージェントループ、ツール呼び出しの自動インストルメンテーション。 |
| [LlamaIndex](https://traceroot.ai/docs/integrations/llamaindex) | Python | RAG パイプライン、ドキュメント取り込み、検索、LLM 合成の自動インストルメンテーション。 |
| [CrewAI](https://traceroot.ai/docs/integrations/crewai) | Python | マルチエージェント協調ワークフローとタスク実行の自動インストルメンテーション。 |
| [Agno](https://traceroot.ai/docs/integrations/agno) | Python | エージェント実行、ツール呼び出し、マルチステップ推論の自動インストルメンテーション。 |
| [DSPy](https://traceroot.ai/docs/integrations/dspy) | Python | モジュール実行、シグネチャ予測、基盤となる LLM 呼び出しの自動インストルメンテーション。 |
| [Google ADK](https://traceroot.ai/docs/integrations/google-adk) | Python | エージェント実行、ツール実行、マルチターンのエージェントループの自動インストルメンテーション。 |

> ご利用のフレームワークやプロバイダーが見つかりませんか？[インテグレーションをリクエスト](https://github.com/traceroot-ai/traceroot/issues)してください。

## SDK

| 言語 | リポジトリ |
| ---- | ---------- |
| Python | [traceroot-py](https://github.com/traceroot-ai/traceroot-py) |
| TypeScript | [traceroot-ts](https://github.com/traceroot-ai/traceroot-ts) |

## Python SDK クイックスタート

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

## TypeScript SDK クイックスタート

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

## セキュリティとプライバシー

お客様のデータセキュリティとプライバシーは、私たちの最優先事項です。詳しくは [Security and Privacy](SECURITY.md) ドキュメントをご覧ください。

## コミュニティ

私たちのエージェント型デバッグランタイムの基盤を支えている [pi-mono](https://github.com/badlogic/pi-mono) プロジェクトに特別な感謝を捧げます！

**コントリビュート** 🤝: コントリビュートに興味がある場合は、[こちら](/CONTRIBUTING.md) のガイドをご確認ください。あらゆる種類の支援を歓迎します :)

**サポート** 💬: 何らかのサポートが必要な場合、通常は [Discord チャンネル](https://discord.gg/TM2m3CtKuC) が最も反応しやすいですが、`founders@traceroot.ai` へのメールもお気軽にどうぞ！

## ライセンス

このプロジェクトは [Apache 2.0](LICENSE) の下でライセンスされており、追加の [Enterprise features](./ee/LICENSE) があります。

## コントリビューター

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
