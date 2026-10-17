"use client";

import { useState } from "react";
import { cn } from "@/lib/utils";
import { LoadingState } from "@/components/ui/loading-state";
import { useProject } from "@/features/projects/hooks";
import { ApiKeyBlock } from "./ApiKeyBlock";
import { CodeBlock } from "./CodeBlock";
import { ExternalIntegrations } from "./ExternalIntegrations";
import { WorkspaceUnavailable } from "./WorkspaceUnavailable";
import { ALL_LANGS, type IntegrationOption, type Lang } from "./integrations";

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

interface ManualTabProps {
  projectId: string;
  /**
   * The stack chosen above this section. It arrives as a prop rather than being
   * chosen in here so that the picker — and the key field that follows it — keep
   * their place when the reader switches between the command and these steps.
   */
  integration: IntegrationOption;
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
 */
export function ManualTab({ projectId, integration }: ManualTabProps) {
  const { data: project, isLoading: projectLoading } = useProject(projectId);
  const workspaceId = project?.workspace_id;
  const [lang, setLang] = useState<Lang>("python");

  const availableLangs = ALL_LANGS.filter((l) => integration.languages[l]);
  const resolvedLang = availableLangs.includes(lang) ? lang : availableLangs[0];
  const config = resolvedLang !== undefined ? integration.languages[resolvedLang] : undefined;

  if (!config || !resolvedLang) {
    if (process.env.NODE_ENV !== "production") {
      throw new Error(
        `Integration "${integration.id}" has no languages defined. Check INTEGRATIONS in integrations.tsx.`,
      );
    }
    return null;
  }

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

      <div className="space-y-2">
        <div className="flex items-center justify-between gap-3">
          <p className="text-[13px] font-medium text-foreground">
            3. Initialize TraceRoot for {integration.name}
          </p>
          {/* Kept beside the snippet it explains, and it moves with the
              selection: the page the reader needs is the one for the stack
              whose code is on screen. */}
          <a
            href={integration.href}
            target="_blank"
            rel="noopener noreferrer"
            className="shrink-0 text-[12px] text-muted-foreground underline-offset-4 transition-colors hover:text-foreground hover:underline"
          >
            View {integration.name} docs
          </a>
        </div>
        <LangTabs lang={resolvedLang} onChange={setLang} availableLangs={availableLangs} />
        <CodeBlock label={resolvedLang} value={config.initSnippet} language={resolvedLang} />
      </div>

      <div className="space-y-2">
        <p className="text-[13px] font-medium text-foreground">4. External integrations</p>
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
