"use client";

import { useState } from "react";
import { LoadingState } from "@/components/ui/loading-state";
import { useProject } from "@/features/projects/hooks";
import { ModelProviderBlock } from "./ModelProviderBlock";
import { StackSelector } from "./StackSelector";
import { WorkspaceUnavailable } from "./WorkspaceUnavailable";
import { INTEGRATIONS, type IntegrationOption } from "./integrations";

/**
 * Which stack the rest of the setup is about.
 *
 * A hook rather than state inside the block below, because the answer is needed
 * on both sides of it: the block renders the picker and the key field it drives,
 * and the section underneath — a walkthrough, in both callers — renders the
 * snippets for the same selection. Lifting it is what lets the two sit as
 * siblings instead of nesting the whole of setup inside the picker.
 *
 * The lookup and its fallback live here too, so neither caller can derive the
 * selected entry slightly differently from the other.
 */
export function useStackSelection(): {
  selected: IntegrationOption;
  select: (integrationId: string) => void;
} {
  const [selectedId, setSelectedId] = useState("openai");
  const selected =
    INTEGRATIONS.find((integration) => integration.id === selectedId) ?? INTEGRATIONS[0];
  return { selected, select: setSelectedId };
}

interface StackAndModelKeyProps {
  /** The project whose workspace owns the key being stored. */
  projectId: string;
  selected: IntegrationOption;
  onSelect: (integrationId: string) => void;
}

/**
 * The two questions every route to a first trace has to ask, wherever it is
 * asked from.
 *
 * Which stack you have decides which provider's key the field below asks for,
 * and the manual route's install command, snippet and docs link. Whose model
 * key the assistant and the detectors run on is the same question whether a
 * coding agent is about to edit the repository, you are about to edit it
 * yourself, or you are halfway through signing up. So it is one component used
 * in both places rather than two arrangements of the same two fields:
 * onboarding's manual step used to render the walkthrough alone, which then
 * had to ask both questions itself, through a second picker grouped
 * differently from this one and a key field numbered in among the steps — so
 * the same account met a different picker for the same question depending on
 * where it started.
 *
 * Returns a fragment, so the caller's own list spacing applies: the traces
 * panel spaces its sections at 6 and the onboarding card at 4, and the two
 * questions are sections of whichever list they are dropped into rather than a
 * box of their own.
 */
export function StackAndModelKey({ projectId, selected, onSelect }: StackAndModelKeyProps) {
  const { data: project, isLoading: projectLoading } = useProject(projectId);
  const workspaceId = project?.workspace_id;

  return (
    <>
      <StackSelector selected={selected} onSelect={onSelect} />

      <div className="space-y-2">
        <p className="text-[13px] font-medium text-foreground">Use your own model key</p>
        {/* The heading stays general while the field below it is named for
            the provider the stack asks for. A heading that renamed itself on
            every selection would move the mode switch and the whole section
            under it, which is the reflow this layout exists to stop. */}
        {projectLoading ? (
          <LoadingState label="Loading model providers..." />
        ) : workspaceId ? (
          <ModelProviderBlock workspaceId={workspaceId} providerKey={selected.providerKey} />
        ) : (
          <WorkspaceUnavailable />
        )}
      </div>
    </>
  );
}
