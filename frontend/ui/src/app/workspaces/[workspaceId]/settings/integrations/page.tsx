"use client";

import { useParams } from "next/navigation";
import { WorkspaceBreadcrumb } from "@/features/workspaces/components";
import { IntegrationsTab } from "@/features/settings/workspace";
import { useWorkspaceSettingsAccess } from "@/features/settings/demo-access";
import { SettingsLayout, WORKSPACE_SETTINGS_TABS } from "@/features/settings/settings-layout";

export default function WorkspaceSettingsIntegrationsPage() {
  const params = useParams();
  const workspaceId = params.workspaceId as string;
  const access = useWorkspaceSettingsAccess(workspaceId, "integrations");

  return (
    <div className="flex h-full">
      <WorkspaceBreadcrumb workspaceId={workspaceId} current="Settings" />

      <SettingsLayout
        tabs={WORKSPACE_SETTINGS_TABS}
        activeTab="integrations"
        access={access}
        basePath={`/workspaces/${workspaceId}/settings`}
      >
        <IntegrationsTab workspaceId={workspaceId} />
      </SettingsLayout>
    </div>
  );
}
