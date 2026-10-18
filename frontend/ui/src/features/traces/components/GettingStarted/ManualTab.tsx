"use client";

import { useState } from "react";
import { cn } from "@/lib/utils";
import { LoadingState } from "@/components/ui/loading-state";
import { useProject } from "@/features/projects/hooks";
import { ApiKeyBlock } from "./ApiKeyBlock";
import { CodeBlock } from "./CodeBlock";
import { ExternalIntegrations } from "./ExternalIntegrations";
import { IntegrationPickerCard } from "./IntegrationPickerCard";
import { ModelProviderBlock } from "./ModelProviderBlock";
import { SectionLink } from "./SectionLink";
import { WorkspaceUnavailable } from "./WorkspaceUnavailable";
import {
  ALL_LANGS,
  INTEGRATIONS,
  type IntegrationCategory,
  type IntegrationOption,
  type Lang,
} from "./integrations";

/**
 * The two groups this tab's own picker shows: providers, and everything else.
 *
 * The panel's picker splits "everything else" into SDKs and agent frameworks,
 * but this one keeps the split it had before that picker existed, so a
 * walkthrough rendered on its own looks exactly as it did.
 */
const OWN_PICKER_GROUPS: {
  key: string;
  label: string;
  includes: (category: IntegrationCategory) => boolean;
}[] = [
  { key: "provider", label: "Model Providers", includes: (category) => category === "provider" },
  { key: "framework", label: "Frameworks", includes: (category) => category !== "provider" },
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
              "-mb-px border-b-2 px-3 py-1.5 text-[12px] font-medium transition-colors",
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

/** The stack picker as a numbered step, for a tab that has no picker above it. */
function OwnStackPicker({
  selected,
  onSelect,
}: {
  selected: IntegrationOption;
  onSelect: (id: string) => void;
}) {
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <p className="text-[13px] font-medium text-foreground">3. Select your integration</p>
        <SectionLink href="https://github.com/traceroot-ai/traceroot/issues/new">
          Don&apos;t see yours? Request one
        </SectionLink>
      </div>

      {OWN_PICKER_GROUPS.map((group) => {
        const items = INTEGRATIONS.filter((integration) => group.includes(integration.category));
        if (items.length === 0) return null;

        return (
          <div key={group.key} className="space-y-1.5">
            <p className="text-[12px] font-medium text-muted-foreground">{group.label}</p>
            <div role="radiogroup" aria-label={group.label} className="flex flex-wrap gap-2">
              {items.map((integration) => (
                <IntegrationPickerCard
                  key={integration.id}
                  integration={integration}
                  selected={selected.id === integration.id}
                  onSelect={() => onSelect(integration.id)}
                />
              ))}
            </div>
          </div>
        );
      })}

      <a
        href={selected.href}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-block text-[12px] text-muted-foreground underline-offset-4 transition-colors hover:text-foreground hover:underline"
      >
        View {selected.name} docs
      </a>
    </div>
  );
}

interface ManualTabProps {
  projectId: string;
  /**
   * The stack chosen above this section. It arrives as a prop rather than being
   * chosen in here so that the picker — and the key field that follows it — keep
   * their place when the reader switches between the command and these steps.
   *
   * Optional, because onboarding's manual step renders this walkthrough on its
   * own, with no picker above it. Without one the tab asks for the stack and the
   * model key itself.
   */
  integration?: IntegrationOption;
}

/**
 * Instrumenting by hand: the key, the install, the one call that starts tracing.
 *
 * Four steps rather than six. The stack picker and the model key that used to
 * be steps 3 and 5 are not gone — they are above this section now, shared with
 * the command, because both routes need the same two answers and neither one
 * belongs to this half. What is left is only the part that is genuinely manual,
 * which is also what makes the numbers worth keeping: these four are done in
 * order, in a terminal and an editor, and the picker above is not.
 *
 * Rendered without an `integration`, there is no picker above, so the tab puts
 * both back as steps 3 and 5 and is the six-step walkthrough it was before.
 */
export function ManualTab({ projectId, integration }: ManualTabProps) {
  const { data: project, isLoading: projectLoading } = useProject(projectId);
  const workspaceId = project?.workspace_id;
  const [selectedIntegrationId, setSelectedIntegrationId] = useState("openai");
  const [lang, setLang] = useState<Lang>("python");

  const selectedIntegration =
    integration ??
    INTEGRATIONS.find((candidate) => candidate.id === selectedIntegrationId) ??
    INTEGRATIONS[0];
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

  const ownsStack = !integration;

  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <p className="text-[13px] font-medium text-foreground">1. Create an API key</p>
        <ApiKeyBlock projectId={projectId} />
      </div>

      <div className="space-y-2">
        <p className="text-[13px] font-medium text-foreground">2. Install SDK</p>
        <LangTabs lang={resolvedLang} onChange={setLang} availableLangs={availableLangs} />
        <CodeBlock label="bash" value={config.installCommand} />
      </div>

      {ownsStack && (
        <OwnStackPicker selected={selectedIntegration} onSelect={setSelectedIntegrationId} />
      )}

      <div className="space-y-2">
        {ownsStack ? (
          <p className="text-[13px] font-medium text-foreground">
            4. Initialize TraceRoot for {selectedIntegration.name}
          </p>
        ) : (
          <div className="flex items-center justify-between gap-3">
            <p className="text-[13px] font-medium text-foreground">
              3. Initialize TraceRoot for {selectedIntegration.name}
            </p>
            {/* Kept beside the snippet it explains, and it moves with the
                selection: the page the reader needs is the one for the stack
                whose code is on screen. */}
            <SectionLink href={selectedIntegration.href}>
              View {selectedIntegration.name} docs
            </SectionLink>
          </div>
        )}
        <LangTabs lang={resolvedLang} onChange={setLang} availableLangs={availableLangs} />
        <CodeBlock label={resolvedLang} value={config.initSnippet} language={resolvedLang} />
      </div>

      {ownsStack && (
        <div className="space-y-2">
          <p className="text-[13px] font-medium text-foreground">5. Use your own model key</p>
          {projectLoading ? (
            <LoadingState label="Loading model providers..." />
          ) : workspaceId ? (
            <ModelProviderBlock
              workspaceId={workspaceId}
              providerKey={selectedIntegration.providerKey}
              stackName={selectedIntegration.name}
            />
          ) : (
            <WorkspaceUnavailable />
          )}
        </div>
      )}

      <div className="space-y-2">
        <p className="text-[13px] font-medium text-foreground">
          {ownsStack ? "6. External integrations" : "4. External integrations"}
        </p>
        {projectLoading ? (
          <LoadingState label="Loading integrations..." />
        ) : workspaceId ? (
          <ExternalIntegrations workspaceId={workspaceId} />
        ) : (
          <WorkspaceUnavailable />
        )}
      </div>
    </div>
  );
}
