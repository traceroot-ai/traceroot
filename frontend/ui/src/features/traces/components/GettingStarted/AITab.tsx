"use client";

import { useProject } from "@/features/projects/hooks";
import { ApiKeyBlock } from "./ApiKeyBlock";
import { OptionalNextSteps } from "./OptionalNextSteps";
import { SetupTabs } from "./SetupTabs";

interface AITabProps {
  projectId: string;
}

export function AITab({ projectId }: AITabProps) {
  const { data: project } = useProject(projectId);
  const workspaceId = project?.workspace_id ?? "";
  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <p className="text-sm font-medium text-foreground">1. Create an API key</p>
        <ApiKeyBlock projectId={projectId} />
      </div>

      <div className="space-y-2">
        <p className="text-sm font-medium text-foreground">2. Set up tracing</p>
        <p className="text-xs text-muted-foreground">
          Pick how you&apos;d like to get going — hand a prompt to your AI agent, add the skills, or
          use the CLI to verify traces once your app is instrumented.
        </p>
        <SetupTabs />
      </div>

      <div className="space-y-2">
        <p className="text-sm font-medium text-foreground">3. Optional next steps</p>
        <OptionalNextSteps workspaceId={workspaceId} />
      </div>
    </div>
  );
}
