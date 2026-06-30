"use client";

import { GitHubConnectButton } from "@/components/github/GitHubConnectButton";
import { SlackConnectButton } from "@/components/slack/SlackConnectButton";
import { useProject } from "@/features/projects/hooks";
import { ApiKeyBlock } from "./ApiKeyBlock";
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
        <p className="text-sm font-medium text-foreground">
          3. Optionally connect your GitHub repositories
        </p>
        <div className="rounded-sm border border-border bg-muted/30 px-4 py-3">
          <p className="text-xs text-muted-foreground">
            Install the GitHub App for repository linking and code-level tracing during root cause
            analysis.
          </p>
          <div className="mt-3">
            <GitHubConnectButton workspaceId={workspaceId} />
          </div>
        </div>
      </div>

      <div className="space-y-2">
        <p className="text-sm font-medium text-foreground">
          4. Optionally connect Slack for alerts
        </p>
        <div className="rounded-sm border border-border bg-muted/30 px-4 py-3">
          <p className="text-xs text-muted-foreground">
            Connect Slack to get detector alerts posted to a channel so your team is notified about
            issues.
          </p>
          <div className="mt-3">
            <SlackConnectButton workspaceId={workspaceId} />
          </div>
        </div>
      </div>
    </div>
  );
}
