"use client";

import { GitHubConnectButton } from "@/components/github/GitHubConnectButton";

interface IntegrationsTabProps {
  workspaceId: string;
}

export function IntegrationsTab({ workspaceId: _workspaceId }: IntegrationsTabProps) {
  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-semibold">Integrations</h2>
        <p className="text-sm text-muted-foreground">
          Connect third-party services to enhance your workspace
        </p>
      </div>

      <div className="border">
        <div className="border-b bg-muted/30 px-4 py-3">
          <h3 className="text-sm font-medium">Connected Services</h3>
        </div>
        <div className="px-4 py-3">
          <GitHubConnectButton />
        </div>
      </div>
    </div>
  );
}
