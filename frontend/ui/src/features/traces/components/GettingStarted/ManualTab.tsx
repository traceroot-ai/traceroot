"use client";

import { useState, type ReactNode } from "react";
import { Link as LinkIcon } from "lucide-react";
import { SiCrewai } from "react-icons/si";
import { cn } from "@/lib/utils";
import { CopyButton } from "@/components/ui/copy-button";
import { GitHubConnectButton } from "@/components/github/GitHubConnectButton";
import { ApiKeyBlock } from "./ApiKeyBlock";

type Lang = "python" | "typescript";

interface IntegrationCodeExample {
  installCommand: string;
  initSnippet: string;
}

interface IntegrationOption {
  id: string;
  name: string;
  href: string;
  icon: ReactNode;
  languages: Partial<Record<Lang, IntegrationCodeExample>>;
}

const ALL_LANGS: Lang[] = ["python", "typescript"];
const PYTHON_INSTALL_COMMAND = "pip install traceroot";
const TYPESCRIPT_INSTALL_COMMAND = "npm install @traceroot-ai/traceroot";
const MASTRA_INSTALL_COMMAND =
  "npm install @traceroot-ai/mastra @mastra/core @mastra/observability";

const INTEGRATIONS: IntegrationOption[] = [
  {
    id: "openai",
    name: "OpenAI",
    href: "https://traceroot.ai/docs/integrations/openai",
    icon: (
      <svg
        aria-hidden="true"
        width="24"
        height="24"
        viewBox="0 0 24 24"
        fill="currentColor"
        className="text-foreground"
      >
        <path d="M22.282 9.821a5.985 5.985 0 0 0-.516-4.91 6.046 6.046 0 0 0-6.51-2.9A6.065 6.065 0 0 0 4.981 4.18a5.985 5.985 0 0 0-3.998 2.9 6.046 6.046 0 0 0 .743 7.097 5.98 5.98 0 0 0 .51 4.911 6.051 6.051 0 0 0 6.515 2.9A5.985 5.985 0 0 0 13.26 24a6.056 6.056 0 0 0 5.772-4.206 5.99 5.99 0 0 0 3.997-2.9 6.056 6.056 0 0 0-.747-7.073zM13.26 22.43a4.476 4.476 0 0 1-2.876-1.04l.141-.081 4.779-2.758a.795.795 0 0 0 .392-.681v-6.737l2.02 1.168a.071.071 0 0 1 .038.052v5.583a4.504 4.504 0 0 1-4.494 4.494zM3.6 18.304a4.47 4.47 0 0 1-.535-3.014l.142.085 4.783 2.759a.771.771 0 0 0 .78 0l5.843-3.369v2.332a.08.08 0 0 1-.033.062L9.74 19.95a4.5 4.5 0 0 1-6.14-1.646zM2.34 7.896a4.485 4.485 0 0 1 2.366-1.973V11.6a.766.766 0 0 0 .388.676l5.815 3.355-2.02 1.168a.076.076 0 0 1-.071 0l-4.83-2.786A4.504 4.504 0 0 1 2.34 7.872zm16.597 3.855l-5.843-3.372 2.02-1.168a.076.076 0 0 1 .071 0l4.83 2.791a4.494 4.494 0 0 1-.676 8.105v-5.678a.79.79 0 0 0-.402-.678zm2.01-3.023l-.141-.085-4.774-2.782a.776.776 0 0 0-.785 0L9.409 9.23V6.897a.066.066 0 0 1 .028-.061l4.83-2.787a4.5 4.5 0 0 1 6.68 4.66zm-12.64 4.135l-2.02-1.164a.08.08 0 0 1-.038-.057V6.075a4.5 4.5 0 0 1 7.375-3.453l-.142.08L8.704 5.46a.795.795 0 0 0-.393.681zm1.097-2.365l2.602-1.5 2.607 1.5v2.999l-2.597 1.5-2.607-1.5z" />
      </svg>
    ),
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
    icon: <LinkIcon className="h-6 w-6 text-foreground" />,
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
    icon: (
      <svg
        aria-hidden="true"
        width="24"
        height="24"
        viewBox="0 0 24 24"
        fill="currentColor"
        className="text-foreground"
      >
        <path d="M17.3041 3.541h-3.6718l6.696 16.918H24Zm-10.6082 0L0 20.459h3.7442l1.3693-3.5527h7.0052l1.3693 3.5528h3.7442L10.5363 3.5409Zm-.3712 10.2232 2.2914-5.9456 2.2914 5.9456Z" />
      </svg>
    ),
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
    icon: (
      <svg
        aria-hidden="true"
        width="24"
        height="24"
        viewBox="0 0 24 24"
        fill="currentColor"
        fillRule="nonzero"
        className="text-foreground"
      >
        <path d="M12 24A14.304 14.304 0 0 0 0 12 14.304 14.304 0 0 0 12 0a14.305 14.305 0 0 0 12 12 14.305 14.305 0 0 0-12 12" />
      </svg>
    ),
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
    icon: (
      <div className="flex h-6 w-6 items-center justify-center">
        <svg
          aria-hidden="true"
          width="24"
          height="15"
          viewBox="0 0 34 21"
          fill="currentColor"
          className="text-foreground"
        >
          <path d="M4.49805 11.6934C6.98237 11.6934 8.99609 13.7081 8.99609 16.1924C8.9959 18.6765 6.98225 20.6904 4.49805 20.6904C2.01394 20.6903 0.000196352 18.6765 0 16.1924C0 13.7081 2.01382 11.6935 4.49805 11.6934ZM10.3867 0C12.8709 0 14.8846 2.01388 14.8848 4.49805C14.8848 4.8377 14.847 5.16846 14.7755 5.48643C14.4618 6.88139 14.1953 8.4633 14.9928 9.65L16.2575 11.5319C16.3363 11.6491 16.4727 11.7115 16.6137 11.703C16.7369 11.6957 16.8525 11.6343 16.9214 11.5318L18.1876 9.64717C18.9772 8.47198 18.7236 6.90783 18.4205 5.52484C18.3523 5.21392 18.3164 4.89094 18.3164 4.55957C18.3167 2.07546 20.3313 0.0615234 22.8154 0.0615234C25.2994 0.0617476 27.3132 2.0756 27.3135 4.55957C27.3135 4.93883 27.2665 5.30712 27.178 5.65896C26.8547 6.94441 26.5817 8.37932 27.2446 9.52714L28.459 11.6301C28.4819 11.6697 28.5245 11.6934 28.5703 11.6934C31.0545 11.6935 33.0684 13.7081 33.0684 16.1924C33.0682 18.6765 31.0544 20.6903 28.5703 20.6904C26.0861 20.6904 24.0725 18.6765 24.0723 16.1924C24.0723 15.8049 24.1212 15.4288 24.2133 15.0701C24.5458 13.7746 24.8298 12.3251 24.1609 11.1668L23.0044 9.16384C22.9656 9.09659 22.8931 9.05859 22.8154 9.05859C22.7983 9.05859 22.7824 9.06614 22.7728 9.08033L21.4896 10.9895C20.686 12.1851 20.9622 13.781 21.284 15.1851C21.3582 15.5089 21.3975 15.8461 21.3975 16.1924C21.3973 18.6764 19.3834 20.6902 16.8994 20.6904C14.4152 20.6904 12.4006 18.6765 12.4004 16.1924C12.4004 15.932 12.4226 15.6768 12.4651 15.4286C12.6859 14.14 12.8459 12.7122 12.1167 11.6271L11.2419 10.3253C10.6829 9.49347 9.71913 9.05932 8.78286 8.70188C7.0906 8.05584 5.88867 6.41734 5.88867 4.49805C5.88886 2.0139 7.90254 3.29835e-05 10.3867 0Z" />
        </svg>
      </div>
    ),
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
    id: "crewai",
    name: "CrewAI",
    href: "https://traceroot.ai/docs/integrations/crewai",
    icon: <SiCrewai className="h-6 w-6 text-foreground" />,
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
    id: "llamaindex",
    name: "LlamaIndex",
    href: "https://traceroot.ai/docs/integrations/llamaindex",
    icon: (
      <svg
        aria-hidden="true"
        width="24"
        height="24"
        viewBox="0 0 24 24"
        fill="currentColor"
        className="text-foreground"
      >
        <path d="M15.855 17.122c-2.092.924-4.358.545-5.23.24 0 .21-.01.857-.048 1.78-.038.924-.332 1.507-.475 1.684.016.577.029 1.837-.047 2.26a1.93 1.93 0 0 1-.476.914H8.295c.114-.577.555-.946.761-1.058.114-1.193-.11-2.229-.238-2.597-.126.449-.437 1.49-.665 2.068a6.418 6.418 0 0 1-.713 1.299h-.951c-.048-.578.27-.77.475-.77.095-.177.323-.731.476-1.54.152-.807-.064-2.324-.19-2.981v-2.068c-1.522-.818-2.092-1.636-2.473-2.55-.304-.73-.222-1.843-.142-2.308-.096-.176-.373-.625-.476-1.25-.142-.866-.063-1.491 0-1.828-.095-.096-.285-.587-.285-1.78 0-1.192.349-1.811.523-1.972v-.529c-.666-.048-1.331-.336-1.712-.721-.38-.385-.095-.962.143-1.154.238-.193.475-.049.808-.145.333-.096.618-.192.76-.48C4.512 1.403 4.287.448 4.16 0c.57.077.935.577 1.046.818V0c.713.337 1.997 1.154 2.425 2.934.342 1.424.586 4.409.665 5.723 1.823.016 4.137-.26 6.229.193 1.901.412 2.757 1.25 3.755 1.25.999 0 1.57-.577 2.282-.096.714.481 1.094 1.828.999 2.838-.076.808-.697 1.074-.998 1.106-.38 1.27 0 2.485.237 2.934v1.827c.111.16.333.655.333 1.347 0 .693-.222 1.154-.333 1.299.19 1.077-.08 2.18-.238 2.597h-1.283c.152-.385.412-.481.523-.481.228-1.193.063-2.293-.048-2.693-.722-.424-1.188-1.17-1.331-1.491.016.272-.029 1.029-.333 1.875-.304.847-.76 1.347-.95 1.491v1.01h-1.284c0-.615.348-.737.523-.721.222-.4.76-1.01.76-2.212 0-1.015-.713-1.492-1.236-2.405-.248-.434-.127-.978-.047-1.203z" />
      </svg>
    ),
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

function LangTabs({
  lang,
  onChange,
  availableLangs = ALL_LANGS,
}: {
  lang: Lang;
  onChange: (l: Lang) => void;
  availableLangs?: Lang[];
}) {
  return (
    <div className="flex border-b border-border">
      {ALL_LANGS.map((candidate) => {
        const isAvailable = availableLangs.includes(candidate);

        return (
          <button
            key={candidate}
            type="button"
            onClick={() => isAvailable && onChange(candidate)}
            disabled={!isAvailable}
            className={cn(
              "-mb-px border-b-2 px-3 py-1.5 text-xs font-medium transition-colors",
              lang === candidate
                ? "border-foreground text-foreground"
                : "border-transparent text-muted-foreground",
              isAvailable ? "hover:text-foreground" : "cursor-not-allowed opacity-50",
            )}
          >
            {candidate === "python" ? "Python" : "TypeScript"}
          </button>
        );
      })}
    </div>
  );
}

interface ManualTabProps {
  projectId: string;
}

export function ManualTab({ projectId }: ManualTabProps) {
  const [selectedIntegrationId, setSelectedIntegrationId] = useState("openai");
  const [lang, setLang] = useState<Lang>("python");

  const selectedIntegration =
    INTEGRATIONS.find((integration) => integration.id === selectedIntegrationId) ?? INTEGRATIONS[0];
  const availableLangs = ALL_LANGS.filter((l) => selectedIntegration.languages[l]);
  const resolvedLang = availableLangs.includes(lang) ? lang : availableLangs[0];
  const config = selectedIntegration.languages[resolvedLang];

  if (!config) {
    return null;
  }

  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <p className="text-sm font-medium text-foreground">1. Create an API key</p>
        <ApiKeyBlock projectId={projectId} />
      </div>

      <div className="space-y-2">
        <p className="text-sm font-medium text-foreground">2. Install SDK</p>
        <LangTabs lang={resolvedLang} onChange={setLang} availableLangs={availableLangs} />
        <div className="border border-border">
          <div className="flex items-center justify-between border-b border-border px-3 py-1.5">
            <span className="text-xs text-muted-foreground">bash</span>
            <CopyButton value={config.installCommand} className="h-6 w-6" />
          </div>
          <pre className="overflow-x-auto whitespace-pre-wrap bg-muted px-3 py-2.5 font-mono text-xs text-foreground">
            {config.installCommand}
          </pre>
        </div>
      </div>

      <div className="space-y-2">
        <div className="flex items-center justify-between gap-2">
          <p className="text-sm font-medium text-foreground">3. Select your integration</p>
          <a
            href={selectedIntegration.href}
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs text-muted-foreground underline-offset-4 transition-colors hover:text-foreground hover:underline"
          >
            View docs
          </a>
        </div>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
          {INTEGRATIONS.map((integration) => (
            <button
              key={integration.id}
              type="button"
              onClick={() => setSelectedIntegrationId(integration.id)}
              aria-pressed={selectedIntegration.id === integration.id}
              className={cn(
                "flex min-h-20 flex-col items-center justify-center gap-1.5 border px-3 py-3 transition-colors",
                selectedIntegration.id === integration.id
                  ? "border-primary bg-primary/5"
                  : "border-border bg-muted/30 hover:bg-muted/60",
              )}
            >
              {integration.icon}
              <span className="text-center text-xs font-medium text-foreground">
                {integration.name}
              </span>
            </button>
          ))}
        </div>
        {availableLangs.length === 1 && (
          <p className="text-xs text-muted-foreground">
            {selectedIntegration.name} onboarding is currently available in{" "}
            {availableLangs[0] === "python" ? "Python" : "TypeScript"} only.
          </p>
        )}
      </div>

      <div className="space-y-2">
        <p className="text-sm font-medium text-foreground">
          4. Initialize TraceRoot for {selectedIntegration.name}
        </p>
        <LangTabs lang={resolvedLang} onChange={setLang} availableLangs={availableLangs} />
        <div className="border border-border">
          <div className="flex items-center justify-between border-b border-border px-3 py-1.5">
            <span className="text-xs text-muted-foreground">
              {resolvedLang === "python" ? "python" : "typescript"}
            </span>
            <CopyButton value={config.initSnippet} className="h-6 w-6" />
          </div>
          <pre className="overflow-x-auto whitespace-pre-wrap bg-muted px-3 py-2.5 font-mono text-xs leading-relaxed text-foreground">
            {config.initSnippet}
          </pre>
        </div>
      </div>

      <div className="space-y-2">
        <p className="text-sm font-medium text-foreground">
          5. Optionally connect your GitHub repositories
        </p>
        <div className="rounded-sm border border-border bg-muted/30 px-4 py-3">
          <p className="text-xs text-muted-foreground">
            Install the GitHub App for repository linking and code-level tracing during root cause
            analysis.
          </p>
          <div className="mt-3">
            <GitHubConnectButton />
          </div>
        </div>
      </div>
    </div>
  );
}
