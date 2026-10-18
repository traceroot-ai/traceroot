"use client";

import { useState } from "react";
import { Sparkle, Code2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { LoadingState } from "@/components/ui/loading-state";
import { useProject } from "@/features/projects/hooks";
import { AITab } from "./AITab";
import { ManualTab } from "./ManualTab";
import { ModelProviderBlock } from "./ModelProviderBlock";
import { StackSelector } from "./StackSelector";
import { WorkspaceUnavailable } from "./WorkspaceUnavailable";
import { INTEGRATIONS } from "./integrations";

type Tab = "ai" | "manual";

interface GettingStartedProps {
  projectId: string;
}

/**
 * Everything both routes need, once, above the route itself.
 *
 * The stack and the model key used to live inside the manual walkthrough, which
 * made switching routes reshuffle the whole panel: the same two questions
 * appeared, disappeared and moved depending on which tab was open, and an
 * answer given on one tab was thrown away by opening the other. They are not
 * manual-setup questions. Which stack you have decides the snippets, the docs
 * link and which provider's key the field asks for, and it is just as true of a
 * repository a coding agent is about to instrument as of one you edit yourself.
 *
 * So the order of the page is the order of the decisions: what you are
 * building on, whose model key it should run on, and only then how you would
 * like the tracing added. Switching that last answer changes the section under
 * it and nothing above it — the picker keeps its selection, the key field keeps
 * what has been typed into it, and neither moves by a pixel.
 *
 * "Using AI" says what the automatic route actually is — a coding agent edits
 * the repository — which is the thing a reader weighs before choosing it. The
 * pairing with "Manual" is looser than a strict antonym, and that is the trade:
 * naming the mechanism costs a little symmetry and buys an informed choice.
 */
export function GettingStarted({ projectId }: GettingStartedProps) {
  const [tab, setTab] = useState<Tab>("ai");
  const [selectedIntegrationId, setSelectedIntegrationId] = useState("openai");
  const { data: project, isLoading: projectLoading } = useProject(projectId);
  const workspaceId = project?.workspace_id;

  const selectedIntegration =
    INTEGRATIONS.find((integration) => integration.id === selectedIntegrationId) ?? INTEGRATIONS[0];

  return (
    <div className="w-full p-6">
      <div className="mx-auto w-full max-w-2xl space-y-6 lg:max-w-3xl xl:max-w-4xl">
        <div>
          <h2 className="text-xl font-semibold">Get started with tracing</h2>
          <p className="mt-1 text-[13px] text-muted-foreground">
            No traces in this project yet. Pick what you are building on, then add tracing with one
            command or by hand.
          </p>
        </div>

        <StackSelector selected={selectedIntegration} onSelect={setSelectedIntegrationId} />

        <div className="space-y-2">
          <p className="text-[13px] font-medium text-foreground">Use your own model key</p>
          {/* The heading stays general while the field below it is named for
              the provider the stack asks for. A heading that renamed itself on
              every selection would move the mode switch and the whole section
              under it, which is the reflow this layout exists to stop. */}
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

        <div>
          <div className="flex items-center gap-1 border-b border-border">
            <button
              type="button"
              onClick={() => setTab("ai")}
              className={cn(
                "flex items-center gap-1.5 border-b-2 px-3 py-1.5 text-[13px] font-medium transition-colors",
                tab === "ai"
                  ? "border-foreground bg-muted text-foreground"
                  : "border-transparent text-muted-foreground hover:bg-muted/50 hover:text-foreground",
              )}
            >
              <Sparkle className="h-3.5 w-3.5" />
              Using AI
            </button>
            <button
              type="button"
              onClick={() => setTab("manual")}
              className={cn(
                "flex items-center gap-1.5 border-b-2 px-3 py-1.5 text-[13px] font-medium transition-colors",
                tab === "manual"
                  ? "border-foreground bg-muted text-foreground"
                  : "border-transparent text-muted-foreground hover:bg-muted/50 hover:text-foreground",
              )}
            >
              <Code2 className="h-3.5 w-3.5" />
              Manual
            </button>
          </div>

          <div className="mt-6">
            {tab === "ai" ? (
              <AITab projectId={projectId} />
            ) : (
              <ManualTab projectId={projectId} integration={selectedIntegration} />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
