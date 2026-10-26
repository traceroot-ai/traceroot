"use client";

import { useParams } from "next/navigation";
import { MembersTab } from "@/features/settings/workspace";
import { WorkspaceSettingsLayout } from "@/features/settings/scoped-settings-layout";

export default function WorkspaceSettingsMembersPage() {
  const params = useParams();
  const workspaceId = params.workspaceId as string;

  return (
    <WorkspaceSettingsLayout workspaceId={workspaceId} tab="members">
      <MembersTab workspaceId={workspaceId} />
    </WorkspaceSettingsLayout>
  );
}
