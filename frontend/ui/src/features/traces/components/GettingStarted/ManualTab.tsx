"use client";

import { useState } from "react";
import { cn } from "@/lib/utils";
import { LoadingState } from "@/components/ui/loading-state";
import { useProject } from "@/features/projects/hooks";
import { ApiKeyBlock } from "./ApiKeyBlock";
import { CodeBlock } from "./CodeBlock";
import { sdkHostUrl } from "./commands";
import { ExternalIntegrations } from "./ExternalIntegrations";
import { IntegrationPickerCard } from "./IntegrationPickerCard";
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
 * `StackSelector` calls the second group "Frameworks & SDKs", but this picker
 * keeps the labels the traces page has always shown, so the empty traces page
 * looks as it did.
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
        <p className="text-[13px] font-medium text-foreground">4. Select your integration</p>
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

/**
 * How the key reaches the application, and where its traces go.
 *
 * A step of its own because neither SDK loads a `.env` file: both read the
 * environment of the process they run in. The key in step 1 is shown as a
 * `.env`-style line, and pasted into `.env` it reached nothing unless the
 * application loaded the file itself. Both SDKs also default to TraceRoot Cloud
 * when `TRACEROOT_HOST_URL` is unset, so a self-hosted reader who followed
 * every other step sent their key and first traces there.
 *
 * The host line is drawn only off Cloud, with the origin the setup command
 * passes as `--host` (see `sdkHostUrl`). When that origin cannot be resolved,
 * no value is guessed: the reader is told which variable stopped it and that
 * the address still has to be set.
 *
 * TypeScript gets dotenv's `config()`, as setup writes it, rather than
 * `import "dotenv/config"`: a call can be given a `path` to the `.env` file.
 */
function EnvironmentStep({ lang }: { lang: Lang }) {
  const host = sdkHostUrl();
  const hostUrl = host.kind === "resolved" ? host.hostUrl : null;
  const lines = ['export TRACEROOT_API_KEY="your_key_here"'];
  if (hostUrl !== null) lines.push(`export TRACEROOT_HOST_URL="${hostUrl}"`);

  return (
    <div className="space-y-2">
      <p className="text-[13px] font-medium text-foreground">3. Set environment variables</p>
      <CodeBlock label="bash" value={lines.join("\n")} />
      {host.kind === "unresolved" ? (
        <p className="text-[12px] text-muted-foreground">
          This page cannot work out this deployment&apos;s API address, because{" "}
          <code className="font-mono">{host.variable}</code> is set to{" "}
          <code className="font-mono">{host.value}</code>. Set{" "}
          <code className="font-mono">TRACEROOT_HOST_URL</code> to that address as well, or your
          traces go to TraceRoot Cloud.
        </p>
      ) : hostUrl !== null ? (
        <p className="text-[12px] text-muted-foreground">
          <code className="font-mono">TRACEROOT_HOST_URL</code> points the SDK at this deployment;
          without it, your traces go to TraceRoot Cloud.
        </p>
      ) : null}
      <p className="text-[12px] text-muted-foreground">
        Use the key from step 1. Neither SDK loads a <code className="font-mono">.env</code> file by
        itself, so export {lines.length > 1 ? "these" : "it"} in the shell that runs your
        application, or put {lines.length > 1 ? "them" : "it"} in{" "}
        <code className="font-mono">.env</code> and load that before TraceRoot is initialized:{" "}
        {lang === "python" ? (
          <>
            <code className="font-mono">from dotenv import load_dotenv; load_dotenv()</code>, from
            the <code className="font-mono">python-dotenv</code> package.
          </>
        ) : (
          <>
            <code className="font-mono">config()</code>, from the{" "}
            <code className="font-mono">dotenv</code> package.
          </>
        )}
      </p>
    </div>
  );
}

interface ManualTabProps {
  projectId: string;
  /**
   * The stack, for a caller that has already asked for it above this section —
   * onboarding's manual step, which asks for it together with the model key —
   * so the walkthrough follows that answer instead of asking a second time.
   *
   * Optional, because the traces page passes none: there the tab asks for the
   * stack itself.
   */
  integration?: IntegrationOption;
}

/**
 * Instrumenting by hand: the key, the install, the environment, the one call
 * that starts tracing, and the external integrations.
 *
 * On the traces page the tab picks the stack itself, as step 4, and asks for
 * no model key. The model key is asked for during onboarding instead.
 *
 * Given an `integration`, the stack has been asked for above this section, so
 * the picker step drops out and the five left are renumbered. The docs link
 * then sits beside the snippet heading, since there is no picker to sit under.
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

      <EnvironmentStep lang={resolvedLang} />

      {ownsStack && (
        <OwnStackPicker selected={selectedIntegration} onSelect={setSelectedIntegrationId} />
      )}

      <div className="space-y-2">
        {ownsStack ? (
          <p className="text-[13px] font-medium text-foreground">
            5. Initialize TraceRoot for {selectedIntegration.name}
          </p>
        ) : (
          <div className="flex items-center justify-between gap-3">
            <p className="text-[13px] font-medium text-foreground">
              4. Initialize TraceRoot for {selectedIntegration.name}
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

      <div className="space-y-2">
        <p className="text-[13px] font-medium text-foreground">
          {ownsStack ? "6. External integrations" : "5. External integrations"}
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
