import { LLMAdapter } from "@traceroot/core";

export type Lang = "python" | "typescript";

export interface IntegrationCodeExample {
  installCommand: string;
  initSnippet: string;
}

/**
 * Which group of the stack picker an entry belongs to.
 *
 * "provider" is a model provider's own SDK, where the entry and the key are the
 * same company. The other two split what used to be a single "framework" group,
 * on who owns the agent loop: an "agent-framework" hands you an agent to
 * declare — `Agent`, `Crew`, `create_deep_agent` — and runs it for you, while an
 * "sdk" is a library you call from control flow you wrote yourself, whether
 * that is a model client, a retrieval pipeline or somebody else's finished agent
 * embedded as a dependency.
 *
 * The line is drawn on the integration's own shape rather than on its name:
 * "Claude Agent SDK" and "pi SDK" are both called SDKs and land on opposite
 * sides of it, because one is a framework for agents you write and the other is
 * a coding agent you drive.
 */
export type IntegrationCategory = "provider" | "sdk" | "agent-framework";

/**
 * Which provider key this integration needs, and how firmly.
 *
 * The picker drives the key field, so every entry has to answer "a key for
 * what?" — and the three answers are genuinely different. A provider's own SDK
 * can only use that provider's key ("fixed"). A provider-agnostic framework
 * will take whatever it is handed, so the honest answer is the provider our own
 * example calls, offered as a starting point the user can change
 * ("suggested"). And an entry can name a provider TraceRoot has no BYOK adapter
 * for at all ("none"), which has to be said rather than papered over with a
 * field that cannot store anything.
 *
 * Each entry's binding is derived from the provider its own code example calls
 * — the snippet below it, or the one on the docs page behind its `href` — not
 * from its name. The one-line comment on each records which.
 */
export type ProviderKeyBinding =
  /** The entry is a provider, or that provider's own SDK: no other key works. */
  | { kind: "fixed"; adapter: LLMAdapter }
  /** Provider-agnostic. This is the provider our example uses; the user may switch. */
  | { kind: "suggested"; adapter: LLMAdapter }
  /** The example's provider has no adapter here. Carries its name, for saying so. */
  | { kind: "none"; provider: string };

export interface IntegrationOption {
  id: string;
  name: string;
  href: string;
  category: IntegrationCategory;
  providerKey: ProviderKeyBinding;
  logo: string;
  logoDark?: string;
  languages: Partial<Record<Lang, IntegrationCodeExample>>;
}

export const ALL_LANGS: Lang[] = ["python", "typescript"];

/** The picker's groups, in the order it shows them. */
export const INTEGRATION_GROUPS: { category: IntegrationCategory; label: string }[] = [
  { category: "provider", label: "Model providers" },
  { category: "sdk", label: "SDK integrations" },
  { category: "agent-framework", label: "Agent frameworks" },
];

/** A group tab, or the "All" tab that stands for every group at once. */
export type IntegrationFilter = IntegrationCategory | "all";

/**
 * The catalogue narrowed to one group and one search.
 *
 * Matching is on the displayed name and on the id, so "langgraph" finds
 * "LangChain & LangGraph" by its name and "vercel" finds "Vercel AI SDK" by
 * either. Nothing here touches the selection: a search that hides the selected
 * entry leaves the snippets and the key field below it exactly as they were,
 * which is the point of a filter rather than a chooser.
 */
export function filterIntegrations(
  query: string,
  category: IntegrationFilter = "all",
  integrations: IntegrationOption[] = INTEGRATIONS,
): IntegrationOption[] {
  const needle = query.trim().toLowerCase();
  return integrations.filter((integration) => {
    if (category !== "all" && integration.category !== category) return false;
    if (needle === "") return true;
    return (
      integration.name.toLowerCase().includes(needle) ||
      integration.id.toLowerCase().includes(needle)
    );
  });
}

const PYTHON_INSTALL_COMMAND = "pip install traceroot";
const TYPESCRIPT_INSTALL_COMMAND = "npm install @traceroot-ai/traceroot";
const MASTRA_INSTALL_COMMAND =
  "npm install @traceroot-ai/mastra @mastra/core @mastra/observability";
const PI_INSTALL_COMMAND = "npm install @traceroot-ai/traceroot @earendil-works/pi-coding-agent";
const VERCEL_AI_INSTALL_COMMAND = "npm install @traceroot-ai/traceroot ai @ai-sdk/otel";

// Ordered to mirror the docs integrations overview (frameworks first, then model
// providers, alphabetical within each group). Keep this in sync with
// docs/integrations/overview.mdx. The picker groups by `category` rather than by
// position, so this order only decides the order inside each group.
export const INTEGRATIONS: IntegrationOption[] = [
  {
    id: "agno",
    name: "Agno",
    href: "https://traceroot.ai/docs/integrations/agno",
    category: "agent-framework",
    // Agno takes any model; the example builds the agent on agno.models.anthropic.Claude.
    providerKey: { kind: "suggested", adapter: LLMAdapter.ANTHROPIC },
    logo: "/logo/integrations/agno.png",
    languages: {
      python: {
        installCommand: PYTHON_INSTALL_COMMAND,
        initSnippet: `import traceroot
from traceroot import Integration

traceroot.initialize(integrations=[Integration.AGNO])`,
      },
    },
  },
  {
    id: "autogen",
    name: "AutoGen",
    href: "https://traceroot.ai/docs/integrations/autogen",
    category: "agent-framework",
    // The snippet above initializes Integration.OPENAI, with the others named as swaps.
    providerKey: { kind: "suggested", adapter: LLMAdapter.OPENAI },
    logo: "/logo/integrations/autogen.svg",
    languages: {
      python: {
        installCommand: PYTHON_INSTALL_COMMAND,
        initSnippet: `import traceroot
from traceroot import Integration

traceroot.initialize(integrations=[
    Integration.AUTOGEN,
    Integration.OPENAI,  # Or GOOGLE_GENAI, ANTHROPIC, etc.
])`,
      },
    },
  },
  {
    id: "claude-agent-sdk",
    name: "Claude Agent SDK",
    href: "https://traceroot.ai/docs/integrations/claude-agent-sdk",
    category: "agent-framework",
    // Anthropic's own agent SDK — @anthropic-ai/claude-agent-sdk, ANTHROPIC_API_KEY.
    providerKey: { kind: "fixed", adapter: LLMAdapter.ANTHROPIC },
    logo: "/logo/integrations/claude-agent-sdk.svg",
    languages: {
      python: {
        installCommand: PYTHON_INSTALL_COMMAND,
        initSnippet: `import traceroot
from traceroot import Integration

traceroot.initialize(integrations=[Integration.CLAUDE_AGENT_SDK])`,
      },
      typescript: {
        installCommand: TYPESCRIPT_INSTALL_COMMAND,
        initSnippet: `import * as claudeAgentSDK from "@anthropic-ai/claude-agent-sdk";
import { TraceRoot } from "@traceroot-ai/traceroot";

TraceRoot.initialize({
  instrumentModules: { claudeAgentSDK },
});`,
      },
    },
  },
  {
    id: "crewai",
    name: "CrewAI",
    href: "https://traceroot.ai/docs/integrations/crewai",
    category: "agent-framework",
    // CrewAI drives any LLM; the snippet above initializes Integration.OPENAI.
    providerKey: { kind: "suggested", adapter: LLMAdapter.OPENAI },
    logo: "/logo/integrations/crewai.svg",
    languages: {
      python: {
        installCommand: PYTHON_INSTALL_COMMAND,
        initSnippet: `import traceroot
from traceroot import Integration

traceroot.initialize(integrations=[
    Integration.CREWAI,
    Integration.OPENAI,  # Or GOOGLE_GENAI, ANTHROPIC, etc.
])`,
      },
    },
  },
  {
    id: "dspy",
    name: "DSPy",
    href: "https://traceroot.ai/docs/integrations/dspy",
    category: "sdk",
    // DSPy is provider-agnostic; the docs example is dspy.LM("openai/gpt-4o-mini").
    providerKey: { kind: "suggested", adapter: LLMAdapter.OPENAI },
    logo: "/logo/integrations/dspy.png",
    languages: {
      python: {
        installCommand: PYTHON_INSTALL_COMMAND,
        initSnippet: `import traceroot
from traceroot import Integration

traceroot.initialize(integrations=[Integration.DSPY])`,
      },
    },
  },
  {
    id: "google-adk",
    name: "Google ADK",
    href: "https://traceroot.ai/docs/integrations/google-adk",
    category: "agent-framework",
    // Google's own agent kit — GOOGLE_API_KEY, Gemini models only.
    providerKey: { kind: "fixed", adapter: LLMAdapter.GOOGLE },
    logo: "/logo/integrations/google-adk.png",
    languages: {
      python: {
        installCommand: PYTHON_INSTALL_COMMAND,
        initSnippet: `import traceroot
from traceroot import Integration

traceroot.initialize(integrations=[Integration.GOOGLE_ADK])`,
      },
    },
  },
  {
    id: "langchain",
    name: "LangChain & LangGraph",
    href: "https://traceroot.ai/docs/integrations/langchain",
    category: "agent-framework",
    // LangChain wraps any chat model; the docs example is ChatOpenAI(model="gpt-4o").
    providerKey: { kind: "suggested", adapter: LLMAdapter.OPENAI },
    logo: "/logo/integrations/langchain.png",
    languages: {
      python: {
        installCommand: PYTHON_INSTALL_COMMAND,
        initSnippet: `import traceroot
from traceroot import Integration

traceroot.initialize(integrations=[Integration.LANGCHAIN])`,
      },
      typescript: {
        installCommand: TYPESCRIPT_INSTALL_COMMAND,
        initSnippet: `import * as lcCallbackManager from "@langchain/core/callbacks/manager";
import { TraceRoot } from "@traceroot-ai/traceroot";

TraceRoot.initialize({
  instrumentModules: { langchain: lcCallbackManager },
});`,
      },
    },
  },
  {
    id: "langchain-deepagents",
    name: "LangChain DeepAgents",
    href: "https://traceroot.ai/docs/integrations/langchain-deepagents",
    category: "agent-framework",
    // DeepAgents takes any model; the docs example is claude-sonnet-4-6 / ChatAnthropic.
    providerKey: { kind: "suggested", adapter: LLMAdapter.ANTHROPIC },
    logo: "/logo/integrations/langchain.png",
    languages: {
      python: {
        installCommand: PYTHON_INSTALL_COMMAND,
        initSnippet: `import traceroot
from traceroot import Integration

traceroot.initialize(integrations=[Integration.LANGCHAIN])`,
      },
      typescript: {
        installCommand: TYPESCRIPT_INSTALL_COMMAND,
        initSnippet: `import * as lcCallbackManager from "@langchain/core/callbacks/manager";
import { TraceRoot } from "@traceroot-ai/traceroot";

TraceRoot.initialize({
  instrumentModules: { langchain: lcCallbackManager },
});`,
      },
    },
  },
  {
    id: "llamaindex",
    name: "LlamaIndex",
    href: "https://traceroot.ai/docs/integrations/llamaindex",
    category: "sdk",
    // The snippet initializes Integration.OPENAI and the docs set Settings.llm = OpenAI(...).
    providerKey: { kind: "suggested", adapter: LLMAdapter.OPENAI },
    logo: "/logo/integrations/llamaindex.png",
    languages: {
      python: {
        installCommand: PYTHON_INSTALL_COMMAND,
        initSnippet: `import traceroot
from traceroot import Integration

traceroot.initialize(integrations=[Integration.LLAMA_INDEX])`,
      },
    },
  },
  {
    id: "microsoft-agent-framework",
    name: "Microsoft Agent Framework",
    href: "https://traceroot.ai/docs/integrations/microsoft-agent-framework",
    category: "agent-framework",
    // Any chat client; the docs example is agent_framework.openai.OpenAIChatClient.
    providerKey: { kind: "suggested", adapter: LLMAdapter.OPENAI },
    logo: "/logo/integrations/microsoft-agent-framework.svg",
    languages: {
      python: {
        installCommand: PYTHON_INSTALL_COMMAND,
        initSnippet: `import traceroot
from traceroot import Integration

traceroot.initialize(integrations=[Integration.AGENT_FRAMEWORK])`,
      },
    },
  },
  {
    id: "mastra",
    name: "Mastra",
    href: "https://traceroot.ai/docs/integrations/mastra",
    category: "agent-framework",
    // Mastra takes any AI SDK model; the docs example is anthropic("claude-haiku-4-5-...").
    providerKey: { kind: "suggested", adapter: LLMAdapter.ANTHROPIC },
    logo: "/logo/integrations/mastra.svg",
    logoDark: "/logo/integrations/mastra-dark.svg",
    languages: {
      typescript: {
        installCommand: MASTRA_INSTALL_COMMAND,
        initSnippet: `import { Mastra } from "@mastra/core";
import { Observability } from "@mastra/observability";
import { TraceRootExporter } from "@traceroot-ai/mastra";

const exporter = new TraceRootExporter({
  apiKey: process.env.TRACEROOT_API_KEY,
});

const mastra = new Mastra({
  observability: new Observability({
    configs: {
      traceroot: {
        serviceName: "my-mastra-app",
        exporters: [exporter],
      },
    },
  }),
});`,
      },
    },
  },
  {
    id: "openai-agents-sdk",
    name: "OpenAI Agents SDK",
    href: "https://traceroot.ai/docs/integrations/openai-agents-sdk",
    category: "agent-framework",
    // OpenAI's own agent SDK — @openai/agents, OPENAI_API_KEY.
    providerKey: { kind: "fixed", adapter: LLMAdapter.OPENAI },
    logo: "/logo/integrations/openai-agents-sdk.svg",
    logoDark: "/logo/integrations/openai-agents-sdk-dark.svg",
    languages: {
      python: {
        installCommand: PYTHON_INSTALL_COMMAND,
        initSnippet: `import traceroot
from traceroot import Integration

traceroot.initialize(integrations=[Integration.OPENAI_AGENTS])`,
      },
      typescript: {
        installCommand: TYPESCRIPT_INSTALL_COMMAND,
        initSnippet: `import * as agents from "@openai/agents";
import { TraceRoot } from "@traceroot-ai/traceroot";

TraceRoot.initialize({
  instrumentModules: { openaiAgents: agents },
});`,
      },
    },
  },
  {
    id: "pi",
    name: "pi SDK",
    href: "https://traceroot.ai/docs/integrations/pi",
    category: "sdk",
    // pi carries its own credentials; the docs example injects OPENAI_API_KEY for gpt-4o-mini.
    providerKey: { kind: "suggested", adapter: LLMAdapter.OPENAI },
    logo: "/logo/integrations/pi.svg",
    logoDark: "/logo/integrations/pi-dark.svg",
    languages: {
      typescript: {
        installCommand: PI_INSTALL_COMMAND,
        initSnippet: `import * as pi from "@earendil-works/pi-coding-agent";
import { TraceRoot } from "@traceroot-ai/traceroot";

TraceRoot.initialize({
  instrumentModules: { piCodingAgent: pi },
});`,
      },
    },
  },
  {
    id: "pydantic-ai",
    name: "Pydantic AI",
    href: "https://traceroot.ai/docs/integrations/pydantic-ai",
    category: "agent-framework",
    // Pydantic AI names the model as a string; the docs example is "openai:gpt-4o-mini".
    providerKey: { kind: "suggested", adapter: LLMAdapter.OPENAI },
    logo: "/logo/integrations/pydantic-ai.png",
    languages: {
      python: {
        installCommand: PYTHON_INSTALL_COMMAND,
        initSnippet: `import traceroot
from traceroot import Integration

traceroot.initialize(integrations=[Integration.PYDANTIC_AI])`,
      },
    },
  },
  {
    id: "vercel-ai",
    name: "Vercel AI SDK",
    href: "https://traceroot.ai/docs/integrations/vercel-ai",
    category: "sdk",
    // The AI SDK is provider-agnostic; the docs example is openai("gpt-4o-mini").
    providerKey: { kind: "suggested", adapter: LLMAdapter.OPENAI },
    logo: "/logo/integrations/vercel-ai.svg",
    logoDark: "/logo/integrations/vercel-ai-dark.svg",
    languages: {
      typescript: {
        installCommand: VERCEL_AI_INSTALL_COMMAND,
        initSnippet: `// AI SDK 7. On AI SDK 6 (legacy), see https://traceroot.ai/docs/integrations/vercel-ai
// (no @ai-sdk/otel; set experimental_telemetry: { isEnabled: true } per call).
import { TraceRoot } from "@traceroot-ai/traceroot";
import { registerTelemetry } from "ai";
import { OpenTelemetry } from "@ai-sdk/otel";

// No instrumentModules — the AI SDK emits its own OpenTelemetry spans.
TraceRoot.initialize();

// Required on AI SDK 7 — without it no spans are produced.
registerTelemetry(new OpenTelemetry({ usage: true }));`,
      },
    },
  },
  {
    id: "anthropic",
    name: "Anthropic",
    href: "https://traceroot.ai/docs/integrations/anthropic",
    category: "provider",
    // This entry is the Anthropic SDK itself.
    providerKey: { kind: "fixed", adapter: LLMAdapter.ANTHROPIC },
    logo: "/logo/integrations/anthropic.svg",
    logoDark: "/logo/integrations/anthropic-dark.svg",
    languages: {
      python: {
        installCommand: PYTHON_INSTALL_COMMAND,
        initSnippet: `import traceroot
from traceroot import Integration

traceroot.initialize(integrations=[Integration.ANTHROPIC])`,
      },
      typescript: {
        installCommand: TYPESCRIPT_INSTALL_COMMAND,
        initSnippet: `import Anthropic from "@anthropic-ai/sdk";
import * as anthropicSDK from "@anthropic-ai/sdk";
import { TraceRoot } from "@traceroot-ai/traceroot";

TraceRoot.initialize({
  instrumentModules: { anthropic: anthropicSDK },
});

const client = new Anthropic();`,
      },
    },
  },
  {
    id: "gemini",
    name: "Google Gemini",
    href: "https://traceroot.ai/docs/integrations/gemini",
    category: "provider",
    // This entry is the Google GenAI SDK itself; the adapter is labelled Google Gemini.
    providerKey: { kind: "fixed", adapter: LLMAdapter.GOOGLE },
    logo: "/logo/integrations/gemini.svg",
    languages: {
      python: {
        installCommand: PYTHON_INSTALL_COMMAND,
        initSnippet: `import traceroot
from traceroot import Integration

traceroot.initialize(integrations=[Integration.GOOGLE_GENAI])`,
      },
    },
  },
  {
    id: "mistral",
    name: "Mistral",
    href: "https://traceroot.ai/docs/integrations/mistral",
    category: "provider",
    // The Mistral SDK, and MISTRAL_API_KEY — but LLMAdapter has no Mistral adapter.
    providerKey: { kind: "none", provider: "Mistral" },
    logo: "/logo/integrations/mistral.svg",
    languages: {
      python: {
        installCommand: PYTHON_INSTALL_COMMAND,
        initSnippet: `import traceroot
from traceroot import Integration

traceroot.initialize(integrations=[Integration.MISTRAL])`,
      },
    },
  },
  {
    id: "openai",
    name: "OpenAI",
    href: "https://traceroot.ai/docs/integrations/openai",
    category: "provider",
    // This entry is the OpenAI SDK itself.
    providerKey: { kind: "fixed", adapter: LLMAdapter.OPENAI },
    logo: "/logo/integrations/openai.svg",
    logoDark: "/logo/integrations/openai-dark.svg",
    languages: {
      python: {
        installCommand: PYTHON_INSTALL_COMMAND,
        initSnippet: `import traceroot
from traceroot import Integration

traceroot.initialize(integrations=[Integration.OPENAI])`,
      },
      typescript: {
        installCommand: TYPESCRIPT_INSTALL_COMMAND,
        initSnippet: `import OpenAI from "openai";
import { TraceRoot } from "@traceroot-ai/traceroot";

TraceRoot.initialize({
  instrumentModules: { openAI: OpenAI },
});

const openai = new OpenAI();`,
      },
    },
  },
  {
    id: "openrouter",
    name: "OpenRouter",
    href: "https://traceroot.ai/docs/integrations/openrouter",
    category: "provider",
    // The snippet points the OpenAI client at openrouter.ai with OPENROUTER_API_KEY.
    providerKey: { kind: "fixed", adapter: LLMAdapter.OPENROUTER },
    logo: "/logo/integrations/openrouter.svg",
    logoDark: "/logo/integrations/openrouter-dark.svg",
    languages: {
      python: {
        installCommand: "pip install traceroot openai",
        initSnippet: `import os
import openai
import traceroot
from traceroot import Integration

traceroot.initialize(integrations=[Integration.OPENAI])

client = openai.OpenAI(
    api_key=os.environ["OPENROUTER_API_KEY"],
    base_url="https://openrouter.ai/api/v1",
)`,
      },
      typescript: {
        installCommand: "npm install @traceroot-ai/traceroot openai",
        initSnippet: `import OpenAI from "openai";
import { TraceRoot } from "@traceroot-ai/traceroot";

TraceRoot.initialize({
  instrumentModules: { openAI: OpenAI },
});

const openai = new OpenAI({
  apiKey: process.env.OPENROUTER_API_KEY,
  baseURL: "https://openrouter.ai/api/v1",
});`,
      },
    },
  },
];
