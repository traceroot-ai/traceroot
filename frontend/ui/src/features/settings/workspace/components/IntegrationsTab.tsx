"use client";

import { useT } from "@/lib/i18n/provider";
import { GitHubConnectButton } from "@/components/github/GitHubConnectButton";
import { SlackConnectButton } from "@/components/slack/SlackConnectButton";

interface IntegrationsTabProps {
  workspaceId: string;
}

export function IntegrationsTab({ workspaceId }: IntegrationsTabProps) {
  const t = useT();
  return (
    <div className="space-y-6">
      <div className="-mx-4 -mt-4 flex h-11 items-center gap-3 border-b border-border px-4">
        <h2 className="text-[15px] font-medium">{t("settings.integrations")}</h2>
        <p className="text-sm text-muted-foreground">
          {t("workspaceSettings.integrationsSubtitle")}
        </p>
      </div>

      <div className="border">
        <div className="flex h-9 items-center border-b border-border px-4">
          <h3 className="text-[13px] font-medium">{t("workspaceSettings.connectedServices")}</h3>
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
