"use client";

import { GitHubConnectButton } from "@/components/github/GitHubConnectButton";
import { SlackConnectButton } from "@/components/slack/SlackConnectButton";
import { useT } from "@/lib/i18n/provider";

interface ExternalIntegrationsProps {
  workspaceId: string;
}

/**
 * One card grouping the optional external-service connections (GitHub, Slack)
 * into divider-separated rows. Each renders its self-contained connect row
 * (icon + text + action) with a short description below.
 */
export function ExternalIntegrations({ workspaceId }: ExternalIntegrationsProps) {
  const t = useT();
  return (
    <div className="divide-y divide-border rounded-md border border-border">
      <div className="space-y-2 px-4 py-3">
        <GitHubConnectButton workspaceId={workspaceId} />
        <p className="text-[12px] text-muted-foreground">{t("tracesSetup.githubText")}</p>
      </div>

      <div className="space-y-2 px-4 py-3">
        <SlackConnectButton workspaceId={workspaceId} />
        <p className="text-[12px] text-muted-foreground">{t("tracesSetup.slackText")}</p>
      </div>
    </div>
  );
}
