"use client";

import { useParams } from "next/navigation";
import { WorkspaceBreadcrumb } from "@/features/workspaces/components";
import { MembersTab } from "@/features/settings/workspace";
import { SettingsLayout, WORKSPACE_SETTINGS_TABS } from "@/features/settings/settings-layout";

export default function WorkspaceSettingsMembersPage() {
  const params = useParams();
  const workspaceId = params.workspaceId as string;

  return (
    <div className="flex h-full">
      <WorkspaceBreadcrumb workspaceId={workspaceId} current="Settings" />

      <SettingsLayout
        tabs={WORKSPACE_SETTINGS_TABS}
        activeTab="members"
        basePath={`/workspaces/${workspaceId}/settings`}
      >
        <MembersTab workspaceId={workspaceId} />
      </SettingsLayout>
    </div>
  );
}
