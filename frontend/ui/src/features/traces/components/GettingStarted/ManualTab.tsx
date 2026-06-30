"use client";

import { useState } from "react";
import { cn } from "@/lib/utils";
import { CopyButton } from "@/components/ui/copy-button";
import { useProject } from "@/features/projects/hooks";
import { ApiKeyBlock } from "./ApiKeyBlock";
import { OptionalNextSteps } from "./OptionalNextSteps";
import { IntegrationPickerCard } from "./IntegrationPickerCard";
import { ALL_LANGS, INTEGRATIONS, type IntegrationCategory, type Lang } from "./integrations";

const INTEGRATION_GROUPS: { category: IntegrationCategory; label: string }[] = [
  { category: "framework", label: "Frameworks" },
  { category: "provider", label: "Model providers" },
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
  const { data: project } = useProject(projectId);
  const workspaceId = project?.workspace_id ?? "";
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

      <div className="space-y-3">
        <div className="flex items-center justify-between gap-3">
          <p className="text-sm font-medium text-foreground">3. Select your integration</p>
          <a
            href="https://github.com/traceroot-ai/traceroot/issues/new"
            target="_blank"
            rel="noopener noreferrer"
            className="shrink-0 text-xs text-muted-foreground underline-offset-4 transition-colors hover:text-foreground hover:underline"
          >
            Don&apos;t see yours? Request one
          </a>
        </div>

        {INTEGRATION_GROUPS.map((group) => {
          const items = INTEGRATIONS.filter(
            (integration) => integration.category === group.category,
          );
          if (items.length === 0) return null;

          return (
            <div key={group.category} className="space-y-1.5">
              <p className="text-xs font-medium text-muted-foreground">{group.label}</p>
              <div
                role="radiogroup"
                aria-label={group.label}
                className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3"
              >
                {items.map((integration) => (
                  <IntegrationPickerCard
                    key={integration.id}
                    integration={integration}
                    selected={selectedIntegration.id === integration.id}
                    onSelect={() => setSelectedIntegrationId(integration.id)}
                  />
                ))}
              </div>
            </div>
          );
        })}

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
        <p className="text-sm font-medium text-foreground">5. Optional next steps</p>
        <OptionalNextSteps workspaceId={workspaceId} includeCli />
      </div>
    </div>
  );
}
