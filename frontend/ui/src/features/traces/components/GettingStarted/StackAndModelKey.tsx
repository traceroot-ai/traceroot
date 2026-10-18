"use client";

import { useState, type ReactNode } from "react";
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
 * and the walkthrough underneath renders the snippets for the same selection.
 * Lifting it is what lets the two sit as siblings instead of nesting the whole
 * of setup inside the picker.
 *
 * The lookup and its fallback live here too, so the walkthrough cannot derive
 * the selected entry slightly differently from the block.
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
  /**
   * Rendered between the two questions, for a caller with something to say
   * about the run in progress.
   *
   * There is one such caller: onboarding, whose watch for the first trace
   * belongs where it can be read without scrolling past a walkthrough. A slot
   * rather than a flag because this block has no business knowing what a trace
   * watch is, and because the position — under the stack, above the key — is
   * the whole of what onboarding needs from it.
   */
  afterStack?: ReactNode;
}

/**
 * The two questions onboarding's manual step asks above its walkthrough: which
 * stack, and whose model key.
 *
 * Which stack you have decides which provider's key the field below asks for,
 * and the walkthrough's install command, snippet and docs link, so the field
 * sits directly under the answer it depends on. The empty traces page asks
 * neither question this way: it keeps the stack picker inside its manual tab
 * and asks for no model key, which is asked for during onboarding instead.
 *
 * Returns a fragment, so the caller's own list spacing applies: the two
 * questions are sections of the onboarding card's list rather than a box of
 * their own.
 */
export function StackAndModelKey({
  projectId,
  selected,
  onSelect,
  afterStack,
}: StackAndModelKeyProps) {
  const { data: project, isLoading: projectLoading } = useProject(projectId);
  const workspaceId = project?.workspace_id;

  return (
    <>
      <StackSelector selected={selected} onSelect={onSelect} />

      {afterStack}

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
            providerKey={selected.providerKey}
            stackName={selected.name}
          />
        ) : (
          <WorkspaceUnavailable />
        )}
      </div>
    </>
  );
}
