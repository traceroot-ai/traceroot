"use client";

import { useParams } from "next/navigation";
import { CustomPricingTab } from "@/features/settings/workspace";
import { WorkspaceSettingsLayout } from "@/features/settings/scoped-settings-layout";

export default function WorkspaceSettingsModelPricingPage() {
  const params = useParams();
  const workspaceId = params.workspaceId as string;

  return (
    <WorkspaceSettingsLayout workspaceId={workspaceId} tab="model-pricing">
      <CustomPricingTab workspaceId={workspaceId} />
    </WorkspaceSettingsLayout>
  );
}
