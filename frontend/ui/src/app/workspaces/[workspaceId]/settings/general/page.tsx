"use client";

import { useParams } from "next/navigation";
import { GeneralTab } from "@/features/settings/workspace";
import { WorkspaceSettingsLayout } from "@/features/settings/scoped-settings-layout";

export default function WorkspaceSettingsGeneralPage() {
  const params = useParams();
  const workspaceId = params.workspaceId as string;

  return (
    <WorkspaceSettingsLayout workspaceId={workspaceId} tab="general">
      <GeneralTab workspaceId={workspaceId} />
    </WorkspaceSettingsLayout>
  );
}
