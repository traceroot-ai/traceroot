"use client";

import { useState } from "react";
import { Link as LinkIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { CopyButton } from "@/components/ui/copy-button";
import { GitHubConnectButton } from "@/components/github/GitHubConnectButton";
import { ApiKeyBlock } from "./ApiKeyBlock";

type Lang = "python" | "typescript";

function LangTabs({ lang, onChange }: { lang: Lang; onChange: (l: Lang) => void }) {
  return (
    <div className="flex border-b border-border">
      {(["python", "typescript"] as Lang[]).map((l) => (
        <button
          key={l}
          type="button"
          onClick={() => onChange(l)}
          className={cn(
            "-mb-px border-b-2 px-3 py-1.5 text-xs font-medium transition-colors",
            lang === l
              ? "border-foreground text-foreground"
              : "border-transparent text-muted-foreground hover:text-foreground",
          )}
        >
          {l === "python" ? "Python" : "TypeScript"}
        </button>
      ))}
    </div>
  );
}

interface ManualTabProps {
  projectId: string;
}

export function ManualTab({ projectId }: ManualTabProps) {
  const [installLang, setInstallLang] = useState<Lang>("python");
  const [initLang, setInitLang] = useState<Lang>("python");

  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <p className="text-sm font-medium text-foreground">1. Create an API key</p>
        <ApiKeyBlock projectId={projectId} />
      </div>

      <div className="space-y-2">
        <p className="text-sm font-medium text-foreground">2. Install SDK</p>
        <LangTabs lang={installLang} onChange={setInstallLang} />
        {installLang === "python" ? (
          <div className="border border-border">
            <div className="flex items-center justify-between border-b border-border px-3 py-1.5">
              <span className="text-xs text-muted-foreground">bash</span>
              <CopyButton value="pip install traceroot" className="h-6 w-6" />
            </div>
            <div className="bg-muted px-3 py-2.5 font-mono text-xs">
              <span className="text-blue-600 dark:text-blue-400">pip</span> install traceroot
            </div>
          </div>
        ) : (
          <div className="border border-border">
            <div className="flex items-center justify-between border-b border-border px-3 py-1.5">
              <span className="text-xs text-muted-foreground">bash</span>
              <CopyButton value="npm install @traceroot-ai/traceroot" className="h-6 w-6" />
            </div>
            <div className="bg-muted px-3 py-2.5 font-mono text-xs">
              <span className="text-blue-600 dark:text-blue-400">npm</span> install
              @traceroot-ai/traceroot
            </div>
          </div>
        )}
      </div>

      <div className="space-y-2">
        <p className="text-sm font-medium text-foreground">3. Select your integration</p>
        <div className="flex gap-2">
          <a
            href="https://traceroot.ai/docs/integrations/openai"
            target="_blank"
            rel="noopener noreferrer"
            className="flex w-24 flex-col items-center gap-1.5 border border-border bg-muted/30 py-3 transition-colors hover:bg-muted/60"
          >
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
            <span className="text-xs font-medium text-foreground">OpenAI</span>
          </a>
          <a
            href="https://traceroot.ai/docs/integrations/langchain"
            target="_blank"
            rel="noopener noreferrer"
            className="flex w-24 flex-col items-center gap-1.5 border border-border bg-muted/30 py-3 transition-colors hover:bg-muted/60"
          >
            <LinkIcon className="h-6 w-6 text-foreground" />
            <span className="text-xs font-medium text-foreground">LangChain</span>
          </a>
          <a
            href="https://traceroot.ai/docs/integrations/anthropic"
            target="_blank"
            rel="noopener noreferrer"
            className="flex w-24 flex-col items-center gap-1.5 border border-border bg-muted/30 py-3 transition-colors hover:bg-muted/60"
          >
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
            <span className="text-xs font-medium text-foreground">Anthropic</span>
          </a>
          <a
            href="https://traceroot.ai/docs/integrations/gemini"
            target="_blank"
            rel="noopener noreferrer"
            className="flex w-24 flex-col items-center gap-1.5 border border-border bg-muted/30 py-3 transition-colors hover:bg-muted/60"
          >
            {/* Gemini gem mark — monochrome to match icon style */}
            <svg
              aria-hidden="true"
              width="24"
              height="24"
              viewBox="0 0 24 24"
              fill="currentColor"
              fillRule="nonzero"
              className="text-foreground"
            >
              <path d="M12 24A14.304 14.304 0 000 12 14.304 14.304 0 0012 0a14.305 14.305 0 0012 12 14.305 14.305 0 00-12 12" />
            </svg>
            <span className="text-xs font-medium text-foreground">Gemini</span>
          </a>
          <a
            href="https://traceroot.ai/docs/integrations/mastra"
            target="_blank"
            rel="noopener noreferrer"
            className="flex w-24 flex-col items-center gap-1.5 border border-border bg-muted/30 py-3 transition-colors hover:bg-muted/60"
          >
            {/* Mastra logo — exact path from mastra repo, wrapped in h-6 to align with other icons */}
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
            <span className="text-xs font-medium text-foreground">Mastra</span>
          </a>
          <a
            href="https://traceroot.ai/docs/integrations/langchain-deepagents"
            target="_blank"
            rel="noopener noreferrer"
            className="flex w-24 flex-col items-center gap-1.5 border border-border bg-muted/30 py-3 transition-colors hover:bg-muted/60"
          >
            {/* DeepAgents logo — exact paths from .github/images/logo-dark.svg, monochrome */}
            <svg
              aria-hidden="true"
              width="24"
              height="24"
              viewBox="22 19 54 60"
              fill="currentColor"
              className="text-foreground"
            >
              <path d="M73.7371 42.5435V21.8158H52.3481L52.3482 22.3079C63.4288 22.5936 72.4574 31.6684 73.3601 42.5435H73.7371Z" />
              <path d="M49.7646 21.816H24.729V64.0228C24.729 71.817 30.7399 76.6658 40.4175 76.6658H73.7482V45.8297H49.7646V21.816Z" />
            </svg>
            <span className="text-xs font-medium text-foreground">DeepAgents</span>
          </a>
        </div>
      </div>

      <div className="space-y-2">
        <p className="text-sm font-medium text-foreground">4. Initialize TraceRoot</p>
        <LangTabs lang={initLang} onChange={setInitLang} />
        {initLang === "python" ? (
          <div className="border border-border">
            <div className="flex items-center justify-between border-b border-border px-3 py-1.5">
              <span className="text-xs text-muted-foreground">python</span>
              <CopyButton
                value={
                  "from dotenv import load_dotenv\nload_dotenv()\n\nimport traceroot\nfrom traceroot import Integration\n\ntraceroot.initialize(integrations=[Integration.OPENAI])"
                }
                className="h-6 w-6"
              />
            </div>
            <div className="bg-muted px-3 py-2.5 font-mono text-xs leading-relaxed">
              <div>
                <span className="text-blue-600 dark:text-blue-400">from</span> dotenv{" "}
                <span className="text-blue-600 dark:text-blue-400">import</span> load_dotenv
              </div>
              <div>load_dotenv()</div>
              <div className="mt-1">
                <span className="text-blue-600 dark:text-blue-400">import</span> traceroot
              </div>
              <div>
                <span className="text-blue-600 dark:text-blue-400">from</span> traceroot{" "}
                <span className="text-blue-600 dark:text-blue-400">import</span> Integration
              </div>
              <div className="mt-1">
                traceroot.<span className="text-purple-600 dark:text-purple-400">initialize</span>
                (integrations=[Integration.OPENAI])
              </div>
            </div>
          </div>
        ) : (
          <div className="border border-border">
            <div className="flex items-center justify-between border-b border-border px-3 py-1.5">
              <span className="text-xs text-muted-foreground">typescript</span>
              <CopyButton
                value={
                  "import 'dotenv/config';\nimport { TraceRoot } from '@traceroot-ai/traceroot';\nimport OpenAI from 'openai';\n\nTraceRoot.initialize({\n  instrumentModules: { openAI: OpenAI },\n});"
                }
                className="h-6 w-6"
              />
            </div>
            <div className="bg-muted px-3 py-2.5 font-mono text-xs leading-relaxed">
              <div>
                <span className="text-blue-600 dark:text-blue-400">import</span>{" "}
                <span className="text-orange-600 dark:text-orange-400">
                  &apos;dotenv/config&apos;
                </span>
                ;
              </div>
              <div>
                <span className="text-blue-600 dark:text-blue-400">import</span> {"{ TraceRoot }"}{" "}
                <span className="text-blue-600 dark:text-blue-400">from</span>{" "}
                <span className="text-orange-600 dark:text-orange-400">
                  &apos;@traceroot-ai/traceroot&apos;
                </span>
                ;
              </div>
              <div>
                <span className="text-blue-600 dark:text-blue-400">import</span> OpenAI{" "}
                <span className="text-blue-600 dark:text-blue-400">from</span>{" "}
                <span className="text-orange-600 dark:text-orange-400">&apos;openai&apos;</span>;
              </div>
              <div className="mt-1">
                TraceRoot.<span className="text-purple-600 dark:text-purple-400">initialize</span>(
                {"{"}
              </div>
              <div className="pl-4">instrumentModules: {"{ openAI: OpenAI }"},</div>
              <div>{"});"}</div>
            </div>
          </div>
        )}
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
