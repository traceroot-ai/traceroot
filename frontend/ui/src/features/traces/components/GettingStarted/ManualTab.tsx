"use client";

import { Fragment, useState, type ReactNode } from "react";
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
  INTEGRATION_GROUPS,
  INTEGRATIONS,
  type IntegrationOption,
  type IntegrationSetup,
  type Lang,
} from "./integrations";

// The traces page keeps the "Frameworks" label it has always shown.
const OWN_PICKER_GROUPS = INTEGRATION_GROUPS.map((group) =>
  group.category === "framework" ? { ...group, label: "Frameworks" } : group,
);

/** A step's heading, with the stack's docs link beside it when no picker sits above. */
function StepHeading({ n, title, docs }: { n: number; title: string; docs?: IntegrationOption }) {
  const heading = (
    <p className="text-[13px] font-medium text-foreground">
      {n}. {title}
    </p>
  );
  if (!docs) return heading;
  return (
    <div className="flex items-center justify-between gap-3">
      {heading}
      <SectionLink href={docs.href}>View {docs.name} docs</SectionLink>
    </div>
  );
}

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
    <div className="flex gap-1">
      {ALL_LANGS.map((candidate) => {
        const isAvailable = availableLangs.includes(candidate);

        return (
          <button
            key={candidate}
            type="button"
            onClick={() => isAvailable && onChange(candidate)}
            disabled={!isAvailable}
            className={cn(
              "rounded-[2px] px-2.5 py-1.5 text-[13px] font-medium transition-colors",
              lang === candidate ? "bg-accent text-accent-foreground" : "text-muted-foreground",
              isAvailable
                ? "hover:bg-muted hover:text-foreground"
                : "cursor-not-allowed opacity-50",
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
  step,
}: {
  selected: IntegrationOption;
  onSelect: (id: string) => void;
  step: number;
}) {
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <p className="text-[13px] font-medium text-foreground">{step}. Select your integration</p>
        <SectionLink href="https://github.com/traceroot-ai/traceroot/issues/new">
          Don&apos;t see yours? Request one
        </SectionLink>
      </div>

      {/* One group for the one choice, as in `StackSelector`: the headings
          split the cards visually, and a group per heading would be announced
          as two separate choices. */}
      <div role="radiogroup" aria-label="Integration" className="space-y-3">
        {OWN_PICKER_GROUPS.map((group) => {
          const items = INTEGRATIONS.filter(
            (integration) => integration.category === group.category,
          );
          if (items.length === 0) return null;

          return (
            <div key={group.category} className="space-y-1.5">
              <p className="text-[12px] font-medium text-muted-foreground">{group.label}</p>
              <div className="flex flex-wrap gap-2">
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
      </div>

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

function UnresolvedHostWarning({ variable, value }: { variable: string; value: string }) {
  return (
    <p className="text-[12px] text-muted-foreground">
      This page cannot work out this deployment&apos;s API address, because{" "}
      <code className="font-mono">{variable}</code> is set to{" "}
      <code className="font-mono">{value}</code>. Set{" "}
      <code className="font-mono">TRACEROOT_HOST_URL</code> to the API&apos;s origin yourself, or
      your traces go to traceroot Cloud. Once <code className="font-mono">{variable}</code> is
      corrected and the web app rebuilt, the address appears here: the value is built into the app
      rather than read at startup.
    </p>
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
 * no value is guessed: the reader is told which variable stopped it, that the
 * API's origin still has to be set by hand, and that correcting the variable
 * takes a rebuild, since `NEXT_PUBLIC_*` is inlined at build time.
 *
 * TypeScript gets dotenv's `config()`, as setup writes it, rather than
 * `import "dotenv/config"`: a call can be given a `path` to the `.env` file.
 */
function EnvironmentStep({ n, lang }: { n: number; lang: Lang }) {
  const host = sdkHostUrl();
  const hostUrl = host.kind === "resolved" ? host.hostUrl : null;
  const lines = ['export TRACEROOT_API_KEY="your_key_here"'];
  if (hostUrl !== null) lines.push(`export TRACEROOT_HOST_URL="${hostUrl}"`);

  return (
    <div className="space-y-2">
      <StepHeading n={n} title="Set environment variables" />
      <CodeBlock label="bash" value={lines.join("\n")} />
      {host.kind === "unresolved" ? (
        <UnresolvedHostWarning variable={host.variable} value={host.value} />
      ) : hostUrl !== null ? (
        <p className="text-[12px] text-muted-foreground">
          <code className="font-mono">TRACEROOT_HOST_URL</code> points the SDK at this deployment;
          without it, your traces go to traceroot Cloud.
        </p>
      ) : null}
      <p className="text-[12px] text-muted-foreground">
        Use the key from step 1. Neither SDK loads a <code className="font-mono">.env</code> file by
        itself, so export {lines.length > 1 ? "these" : "it"} in the shell that runs your
        application, or put {lines.length > 1 ? "them" : "it"} in{" "}
        <code className="font-mono">.env</code> and load that before traceroot is initialized:{" "}
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

type NumberedStep = (n: number) => ReactNode;

/** Numbers the steps after step 1, the key, which `ManualTab` renders for both paths. */
function numbered(steps: NumberedStep[]) {
  return steps.map((step, i) => <Fragment key={i}>{step(i + 2)}</Fragment>);
}

interface WalkthroughProps {
  integration: IntegrationOption;
  /** Set when the tab picks the stack itself, as a step of its own. */
  onSelect?: (id: string) => void;
}

function PluginWalkthrough({
  integration,
  setup,
  onSelect,
}: WalkthroughProps & { setup: Extract<IntegrationSetup, { kind: "plugin" }> }) {
  // Point the plugin at this deployment the same way EnvironmentStep does for the SDKs.
  const host = sdkHostUrl();
  const hostUrl = host.kind === "resolved" ? host.hostUrl : null;
  const config = setup.config(hostUrl);

  return numbered([
    (n) => (
      <div className="space-y-2">
        <StepHeading n={n} title="Install the plugin" />
        <CodeBlock label="bash" value={setup.install(hostUrl)} />
      </div>
    ),
    ...(onSelect
      ? [(n: number) => <OwnStackPicker selected={integration} onSelect={onSelect} step={n} />]
      : []),
    (n) => (
      <div className="space-y-2">
        <StepHeading n={n} title="Configure" />
        <CodeBlock label={config.label} value={config.value} />
        {host.kind === "unresolved" && (
          <UnresolvedHostWarning variable={host.variable} value={host.value} />
        )}
      </div>
    ),
    (n) => (
      <div className="space-y-2">
        <StepHeading
          n={n}
          title={`Use ${integration.name} as usual`}
          docs={onSelect ? undefined : integration}
        />
        <p className="text-[12px] text-muted-foreground">
          Send a prompt in {integration.name} to send your first trace.
        </p>
      </div>
    ),
  ]);
}

function SdkWalkthrough({
  integration,
  setup,
  onSelect,
  lang,
  onLangChange,
}: WalkthroughProps & {
  setup: Extract<IntegrationSetup, { kind: "sdk" }>;
  lang: Lang;
  onLangChange: (lang: Lang) => void;
}) {
  const availableLangs = ALL_LANGS.filter((l) => setup.languages[l]);
  const resolvedLang = availableLangs.includes(lang) ? lang : availableLangs[0];
  const example = resolvedLang !== undefined ? setup.languages[resolvedLang] : undefined;

  if (!example || !resolvedLang) {
    if (process.env.NODE_ENV !== "production") {
      throw new Error(
        `Integration "${integration.id}" has no languages defined. Check INTEGRATIONS in integrations.tsx.`,
      );
    }
    return null;
  }

  const langTabs = (
    <LangTabs lang={resolvedLang} onChange={onLangChange} availableLangs={availableLangs} />
  );

  return numbered([
    (n) => (
      <div className="space-y-2">
        <StepHeading n={n} title="Install SDK" />
        {langTabs}
        <CodeBlock label="bash" value={example.installCommand} />
      </div>
    ),
    (n) => <EnvironmentStep n={n} lang={resolvedLang} />,
    ...(onSelect
      ? [(n: number) => <OwnStackPicker selected={integration} onSelect={onSelect} step={n} />]
      : []),
    (n) => (
      <div className="space-y-2">
        <StepHeading
          n={n}
          title={`Initialize traceroot for ${integration.name}`}
          docs={onSelect ? undefined : integration}
        />
        {langTabs}
        <CodeBlock label={resolvedLang} value={example.initSnippet} language={resolvedLang} />
      </div>
    ),
    (n) => (
      <div className="space-y-2">
        <StepHeading n={n} title="Run your application" />
        <p className="text-[12px] text-muted-foreground">
          Make an LLM request through the code you instrumented to send your first trace.
        </p>
      </div>
    ),
  ]);
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
 * Instrumenting by hand, as an SDK walkthrough or, for a coding agent, a plugin one, each
 * followed by the unnumbered external integrations. Without an `integration` the tab adds
 * its own stack picker as a step; with one, the docs link moves beside a step heading.
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
  const { setup } = selectedIntegration;
  const onSelect = integration ? undefined : setSelectedIntegrationId;

  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <StepHeading n={1} title="Create an API key" />
        <ApiKeyBlock projectId={projectId} />
      </div>

      {setup.kind === "plugin" ? (
        <PluginWalkthrough integration={selectedIntegration} setup={setup} onSelect={onSelect} />
      ) : (
        <SdkWalkthrough
          integration={selectedIntegration}
          setup={setup}
          onSelect={onSelect}
          lang={lang}
          onLangChange={setLang}
        />
      )}

      <div className="space-y-2">
        <p className="text-[13px] font-medium text-foreground">External integrations</p>
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
