<div align="center">
  <a href="https://traceroot.ai/">
    <img src="frontend/ui/public/images/traceroot_logo.png" alt="TraceRoot ロゴ">
  </a>

[TraceRoot](https://traceroot.ai/) は、AIエージェント向けのオープンソースの可観測性プラットフォームです。トレースをキャプチャし、ソースコードやGitHubの履歴を把握するAIを使ってデバッグを行います。

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
  <a href="./README.ja.md"><img alt="日本語版README" src="https://img.shields.io/badge/日本語-f8f8f8"></a>
</p>

## 機能

<div align="center">
  <kbd><img src="docs/images/rca_v1.png" alt="エージェント型デバッグ - 根本原因分析"></kbd>
</div>

<br>

| 機能 | 説明 |
| ------- | ----------- |
| トレース | OpenTelemetry互換のSDKを介して、LLMの呼び出し、エージェントのアクション、ツールの使用状況をキャプチャします。ノイズをフィルタリングし、重要なシグナルを優先して、重要なトレースをインテリジェントに抽出します。 |
| エージェント型デバッグ | すべてのトレースを把握し、本番環境のソースコードを含むサンドボックスに接続し、正確な失敗行を特定し、その失敗をGitHubのコミット、プルリクエスト、およびイシューと関連付けるAIです。あらゆるモデルプロバイダーに対応したBYOK（Bring Your Own Key）機能をサポートします。 |

## なぜTraceRootなのか？

- **トレースだけではスケールしません。**

  AIエージェントシステムが複雑化するにつれ、すべてのトレースを手作業で精査することは現実的ではありません。TraceRootはトレースを選別し、ノイズをフィルタリングして、実際に注意が必要なトレースのみを抽出します。これにより、問題の「探索」ではなく「解決」に時間を費やすことができます。

- **AIエージェントシステムのデバッグは困難です。**

  エージェントのハルシネーション、ツール呼び出しの不安定さ、バージョン変更にまたがる障害の根本原因を特定するのは困難です。TraceRootのAIは、本番環境のソースコードを実行しているサンドボックスに接続し、正確な障害発生行を特定して、GitHubの履歴（コミット、プルリクエスト、未解決のイシュー）と照合し、修正するためのプルリクエストを作成します。

- **完全なオープンソース、ベンダーロックインなし。**

  可観測性プラットフォームとAIデバッグレイヤーの両方がオープンソースです。OpenAI、Anthropic、Gemini、xAI、DeepSeek、OpenRouter、Kimi、GLMなど、あらゆるモデルプロバイダーに対応したBYOKをサポートしています。

## ドキュメント

完全なドキュメントは [traceroot.ai/docs](https://traceroot.ai/docs) でご覧いただけます。

## はじめに

### TraceRoot Cloud

最も手っ取り早く始められる方法です。テスト用に十分なストレージとLLMトークンが用意されており、クレジットカードは不要です。[こちら](https://app.traceroot.ai) からサインアップしてください！

### セルフホスティング

- 開発者モード：TraceRootをローカルで実行して貢献しましょう。

  ```bash
  # 最新のリポジトリを取得
  git clone https://github.com/traceroot-ai/traceroot.git
  cd traceroot

  # インフラをDockerで、アプリ自体をローカルでホスト
  make dev
  ```
  詳細については、[CONTRIBUTING.md](CONTRIBUTING.md) をご覧ください。

- ローカルDockerモード：TraceRootをローカルで実行してテストします。

  ```bash
  # 最新のリポジトリを取得
  git clone https://github.com/traceroot-ai/traceroot.git
  cd traceroot

  # すべてをDockerでホスト
  make prod
  ```

- [Terraform (AWS)](./deploy/): HelmとTerraformを使用してk8s上でTraceRootを実行します。これは本番環境でのホスティング用です。まだ実験段階です。

## インテグレーション

### モデルプロバイダー

| インテグレーション | 対応 | 説明 |
| ----------- | -------- | ----------- |
| [OpenAI](https://traceroot.ai/docs/integrations/openai) | Python, JS/TS | Chat CompletionsおよびResponses APIの自動インストルメンテーション。 |
| [Anthropic](https://traceroot.ai/docs/integrations/anthropic) | Python, JS/TS | Messages APIの自動インストルメンテーション。 |
| [Google Gemini](https://traceroot.ai/docs/integrations/gemini) | Python | Google GenAI SDKによる自動インストルメンテーション。 |
| [Mistral](https://traceroot.ai/docs/integrations/mistral) | Python | Mistralのチャット補完、ツール呼び出し、ストリーミングレスポンスの自動インストルメンテーション。 |

### エージェントフレームワーク

| インテグレーション | 対応 | 説明 |
| ----------- | -------- | ----------- |
| [LangChain & LangGraph](https://traceroot.ai/docs/integrations/langchain) | Python, JS/TS | コールバックハンドラーをLangChainアプリケーションに渡すことによる自動インストルメンテーション。 |
| [LangChain DeepAgents](https://traceroot.ai/docs/integrations/langchain-deepagents) | Python, JS/TS | コールバックハンドラーをDeepAgentsパイプラインに渡すことによる自動インストルメンテーション。 |
| [Claude Agent SDK](https://traceroot.ai/docs/integrations/claude-agent-sdk) | Python, JS/TS | エージェント呼び出し、サブエージェント委任、ツール呼び出し、トークン使用量の自動インストルメンテーション。 |
| [OpenAI Agents SDK](https://traceroot.ai/docs/integrations/openai-agents-sdk) | Python, JS/TS | エージェント実行、ツール実行、ハンドオフトランジションの自動インストルメンテーション。 |
| [Mastra](https://traceroot.ai/docs/integrations/mastra) | JS/TS | TraceRoot OTLPエクスポーターによる自動インストルメンテーション。 |
| [Vercel AI SDK](https://traceroot.ai/docs/integrations/vercel-ai) | JS/TS | `experimental_telemetry` によるネイティブOpenTelemetryトレーシング — `instrumentModules` の設定は不要。 |
| [AutoGen](https://traceroot.ai/docs/integrations/autogen) | Python | マルチエージェント会話、エージェントループ、ツール呼び出しの自動インストルメンテーション。 |
| [LlamaIndex](https://traceroot.ai/docs/integrations/llamaindex) | Python | RAGパイプライン、ドキュメント取り込み、検索、LLM合成の自動インストルメンテーション。 |
| [CrewAI](https://traceroot.ai/docs/integrations/crewai) | Python | マルチエージェント協調ワークフローとタスク実行の自動インストルメンテーション。 |
| [Agno](https://traceroot.ai/docs/integrations/agno) | Python | エージェント実行、ツール呼び出し、マルチステップ推論の自動インストルメンテーション。 |
| [DSPy](https://traceroot.ai/docs/integrations/dspy) | Python | モジュール実行、シグネチャ予測、基盤となるLLM呼び出しの自動インストルメンテーション。 |
| [Google ADK](https://traceroot.ai/docs/integrations/google-adk) | Python | エージェント実行、ツール実行、マルチターンエージェントループの自動インストルメンテーション。 |

> お使いのフレームワークやプロバイダーが見つかりませんか？[インテグレーションをリクエスト](https://github.com/traceroot-ai/traceroot/issues)してください。

## SDK

| 言語 | リポジトリ |
| -------- | ---------- |
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

お客様のデータセキュリティとプライバシーは私たちの最優先事項です。詳細は [セキュリティとプライバシー](SECURITY.md) ドキュメントをご覧ください。

## コミュニティ

エージェントデバッグランタイムの基盤を提供してくださった [pi-mono](https://github.com/badlogic/pi-mono) プロジェクトに特別な感謝を申し上げます！

**コントリビュート** 🤝: コントリビュートに興味がある方は、[こちら](/CONTRIBUTING.md)のガイドをご確認ください。あらゆる形のサポートを歓迎します :)

**サポート** 💬: サポートが必要な場合は、[Discordチャンネル](https://discord.gg/TM2m3CtKuC)が最も迅速に対応できますが、`founders@traceroot.ai` へのメールも歓迎します！

## ライセンス

このプロジェクトは [Apache 2.0](LICENSE) ライセンスの下で提供されており、追加の [エンタープライズ機能](./ee/LICENSE) も含まれています。

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
[pypi-sdk-downloads-image]: https://static.pepy.tech/badge/traceroot
[pypi-sdk-downloads-url]: https://pypi.python.org/pypi/traceroot
[y-combinator-image]: https://img.shields.io/badge/Combinator-S25-orange?logo=ycombinator&labelColor=white
[y-combinator-url]: https://www.ycombinator.com/companies/traceroot-ai
[twitter-image]: https://img.shields.io/twitter/follow/TraceRootAI
[twitter-url]: https://x.com/TraceRootAI
