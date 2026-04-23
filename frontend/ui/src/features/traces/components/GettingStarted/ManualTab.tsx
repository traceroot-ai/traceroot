"use client";

import { useState } from "react";
import { cn } from "@/lib/utils";
import { CopyButton } from "@/components/ui/copy-button";
import { GitHubConnectButton } from "@/components/github/GitHubConnectButton";
import { ApiKeyBlock } from "./ApiKeyBlock";
import { ALL_LANGS, INTEGRATIONS, type Lang } from "./integrations";

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
  const config =
    resolvedLang !== undefined ? selectedIntegration.languages[resolvedLang] : undefined;

  if (!config || !resolvedLang) {
    if (process.env.NODE_ENV !== "production") {
      throw new Error(
        `Integration "${selectedIntegration.id}" has no languages defined. Check INTEGRATIONS in integrations.tsx.`,
      );
    }
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
        <p className="text-sm font-medium text-foreground">3. Select your integration</p>
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
        <a
          href={selectedIntegration.href}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-block text-xs text-muted-foreground underline-offset-4 transition-colors hover:text-foreground hover:underline"
        >
          View {selectedIntegration.name} docs
        </a>
      </div>

      <div className="space-y-2">
        <p className="text-sm font-medium text-foreground">
          4. Initialize TraceRoot for {selectedIntegration.name}
        </p>
        <LangTabs lang={resolvedLang} onChange={setLang} availableLangs={availableLangs} />
        <div className="border border-border">
          <div className="flex items-center justify-between border-b border-border px-3 py-1.5">
            <span className="text-xs text-muted-foreground">{resolvedLang}</span>
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
