"use client";

import { useParams } from "next/navigation";
import { ModelProvidersTab } from "@/features/settings/workspace";
import { WorkspaceSettingsLayout } from "@/features/settings/scoped-settings-layout";

export default function WorkspaceSettingsModelProvidersPage() {
  const params = useParams();
  const workspaceId = params.workspaceId as string;

  return (
    <WorkspaceSettingsLayout workspaceId={workspaceId} tab="model-providers">
      <ModelProvidersTab workspaceId={workspaceId} />
    </WorkspaceSettingsLayout>
  );
}
