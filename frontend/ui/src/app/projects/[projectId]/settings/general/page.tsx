"use client";

import { useParams } from "next/navigation";
import { ProjectBreadcrumb } from "@/features/projects/components";
import { GeneralTab } from "@/features/settings/project";
import { SettingsLayout, PROJECT_SETTINGS_TABS } from "@/features/settings/settings-layout";

export default function ProjectSettingsGeneralPage() {
  const params = useParams();
  const projectId = params.projectId as string;

  return (
    <div className="flex h-full">
      <ProjectBreadcrumb projectId={projectId} current="Settings" />

      <SettingsLayout
        tabs={PROJECT_SETTINGS_TABS}
        activeTab="general"
        basePath={`/projects/${projectId}/settings`}
      >
        <GeneralTab projectId={projectId} />
      </SettingsLayout>
    </div>
  );
}
