"use client";

import { useEffect } from "react";
import { useParams } from "next/navigation";
import { useLayout } from "@/components/layout/app-layout";
import { ProjectBreadcrumb } from "@/features/projects/components";
import { AiAssistantPanel } from "@/features/ai-assistant/components/ai-assistant-panel";

/**
 * Home — the AI assistant as a first-class project section. Renders the same
 * assistant panel used by the right rail and viewer panels, as a centered
 * full-page column. Chat state lives in the app-wide AiChatProvider, so a
 * conversation started here survives navigating to other sections.
 */
export default function HomePage() {
  const params = useParams();
  const projectId = params.projectId as string;
  const { registerAiHost } = useLayout();

  // Claim the AI slot for this page so AppLayout's project rail can never
  // double-render the assistant alongside it. `registerAiHost()` returns its
  // own cleanup, which we return from the effect so React releases the slot
  // on unmount and the rail behaves normally elsewhere.
  useEffect(() => {
    return registerAiHost();
  }, [registerAiHost]);

  return (
    <div className="flex h-full flex-col text-[13px]">
      <ProjectBreadcrumb projectId={projectId} />
      <div className="min-h-0 flex-1">
        <AiAssistantPanel projectId={projectId} variant="page" onClose={() => {}} />
      </div>
    </div>
  );
}
