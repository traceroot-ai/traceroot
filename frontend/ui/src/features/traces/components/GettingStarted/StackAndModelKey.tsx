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
