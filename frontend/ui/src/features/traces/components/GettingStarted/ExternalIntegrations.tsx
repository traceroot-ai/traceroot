"use client";

import { GitHubConnectButton } from "@/components/github/GitHubConnectButton";
import { SlackConnectButton } from "@/components/slack/SlackConnectButton";

interface ExternalIntegrationsProps {
  workspaceId: string;
}

/**
 * One card grouping the optional external-service connections (GitHub, Slack)
 * into divider-separated rows. Each renders its self-contained connect row
 * (icon + text + action) with a short description below.
 */
export function ExternalIntegrations({ workspaceId }: ExternalIntegrationsProps) {
  return (
    <div className="divide-y divide-border rounded-md border border-border">
      <div className="space-y-2 px-4 py-3">
        <GitHubConnectButton workspaceId={workspaceId} />
        <p className="text-xs text-muted-foreground">
          Install the GitHub App for repository linking and code-level tracing during root cause
          analysis.
        </p>
      </div>

      <div className="space-y-2 px-4 py-3">
        <SlackConnectButton workspaceId={workspaceId} />
        <p className="text-xs text-muted-foreground">
          Connect Slack to get detector alerts posted to a channel so your team is notified about
          issues.
        </p>
      </div>
    </div>
  );
}
