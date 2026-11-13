"use client";

import { GitHubConnectButton } from "@/components/github/GitHubConnectButton";
import { SlackConnectButton } from "@/components/slack/SlackConnectButton";

interface IntegrationsTabProps {
  workspaceId: string;
}

export function IntegrationsTab({ workspaceId }: IntegrationsTabProps) {
  return (
    <div className="space-y-6">
      <div className="-mx-4 -mt-4 flex h-11 items-center gap-3 border-b border-border px-4">
        <h2 className="text-[15px] font-medium">Integrations</h2>
        <p className="text-sm text-muted-foreground">
          Connect third-party services to enhance your workspace
        </p>
      </div>

      <div className="border">
        <div className="flex h-9 items-center border-b border-border px-4">
          <h3 className="text-[13px] font-medium">Connected services</h3>
        </div>
        <div className="divide-y">
          <div className="px-4 py-3">
            <GitHubConnectButton workspaceId={workspaceId} />
          </div>
          <div className="px-4 py-3">
            <SlackConnectButton workspaceId={workspaceId} />
          </div>
        </div>
      </div>
    </div>
  );
}
