"use client";

import { useParams } from "next/navigation";
import { IntegrationsTab } from "@/features/settings/workspace";
import { WorkspaceSettingsLayout } from "@/features/settings/scoped-settings-layout";

export default function WorkspaceSettingsIntegrationsPage() {
  const params = useParams();
  const workspaceId = params.workspaceId as string;

  return (
    <WorkspaceSettingsLayout workspaceId={workspaceId} tab="integrations">
      <IntegrationsTab workspaceId={workspaceId} />
    </WorkspaceSettingsLayout>
  );
}
