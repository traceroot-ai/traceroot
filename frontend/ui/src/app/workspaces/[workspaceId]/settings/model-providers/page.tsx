"use client";

import { useParams } from "next/navigation";
import { WorkspaceBreadcrumb } from "@/features/workspaces/components";
import { ModelProvidersTab } from "@/features/settings/workspace";
import { SettingsLayout, WORKSPACE_SETTINGS_TABS } from "@/features/settings/settings-layout";

export default function WorkspaceSettingsModelProvidersPage() {
  const params = useParams();
  const workspaceId = params.workspaceId as string;

  return (
    <div className="flex h-full">
      <WorkspaceBreadcrumb workspaceId={workspaceId} current="Settings" />

      <SettingsLayout
        tabs={WORKSPACE_SETTINGS_TABS}
        activeTab="model-providers"
        basePath={`/workspaces/${workspaceId}/settings`}
        crossLink={{ label: "Project Settings", href: `/workspaces/${workspaceId}/projects` }}
      >
        <ModelProvidersTab workspaceId={workspaceId} />
      </SettingsLayout>
    </div>
  );
}
