export type Lang = "python" | "typescript";

export interface IntegrationCodeExample {
  installCommand: string;
  initSnippet: string;
}

export type IntegrationCategory = "provider" | "framework";

export interface IntegrationOption {
  id: string;
  name: string;
  href: string;
  category: IntegrationCategory;
  logo: string;
  logoDark?: string;
  languages: Partial<Record<Lang, IntegrationCodeExample>>;
}

export const ALL_LANGS: Lang[] = ["python", "typescript"];

const PYTHON_INSTALL_COMMAND = "pip install traceroot";
const TYPESCRIPT_INSTALL_COMMAND = "npm install @traceroot-ai/traceroot";
const MASTRA_INSTALL_COMMAND =
  "npm install @traceroot-ai/mastra @mastra/core @mastra/observability";

export const INTEGRATIONS: IntegrationOption[] = [
  {
    id: "openai",
    name: "OpenAI",
    href: "https://traceroot.ai/docs/integrations/openai",
    category: "provider",
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
    id: "langchain",
    name: "LangChain",
    href: "https://traceroot.ai/docs/integrations/langchain",
    category: "framework",
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
    id: "anthropic",
    name: "Anthropic",
    href: "https://traceroot.ai/docs/integrations/anthropic",
    category: "provider",
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
    name: "Gemini",
    href: "https://traceroot.ai/docs/integrations/gemini",
    category: "provider",
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
    id: "mastra",
    name: "Mastra",
    href: "https://traceroot.ai/docs/integrations/mastra",
    category: "framework",
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
    id: "vercel-ai",
    name: "Vercel AI SDK",
    href: "https://traceroot.ai/docs/integrations/vercel-ai",
    category: "framework",
    logo: "/logo/integrations/vercel-ai.svg",
    logoDark: "/logo/integrations/vercel-ai-dark.svg",
    languages: {
      typescript: {
        installCommand: TYPESCRIPT_INSTALL_COMMAND,
        initSnippet: `import { TraceRoot } from "@traceroot-ai/traceroot";

// No instrumentModules — Vercel AI SDK telemetry is handled automatically.
TraceRoot.initialize();

// Then on each generateText / streamText / generateObject call:
//   experimental_telemetry: { isEnabled: true }`,
      },
    },
  },
  {
    id: "crewai",
    name: "CrewAI",
    href: "https://traceroot.ai/docs/integrations/crewai",
    category: "framework",
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
    id: "autogen",
    name: "AutoGen",
    href: "https://traceroot.ai/docs/integrations/autogen",
    category: "framework",
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
    id: "agno",
    name: "Agno",
    href: "https://traceroot.ai/docs/integrations/agno",
    category: "framework",
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
    id: "dspy",
    name: "DSPy",
    href: "https://traceroot.ai/docs/integrations/dspy",
    category: "framework",
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
    id: "mistral",
    name: "Mistral",
    href: "https://traceroot.ai/docs/integrations/mistral",
    category: "provider",
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
    id: "google-adk",
    name: "Google ADK",
    href: "https://traceroot.ai/docs/integrations/google-adk",
    category: "framework",
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
    id: "llamaindex",
    name: "LlamaIndex",
    href: "https://traceroot.ai/docs/integrations/llamaindex",
    category: "framework",
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
];
