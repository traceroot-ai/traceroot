"use client";

import { useParams } from "next/navigation";
import { ProjectBreadcrumb } from "@/features/projects/components";
import { DetectorsTab } from "@/features/settings/project";
import { useProject } from "@/features/projects/hooks";
import { useProjectSettingsAccess } from "@/features/settings/demo-access";
import { SettingsLayout, PROJECT_SETTINGS_TABS } from "@/features/settings/settings-layout";

export default function ProjectSettingsDetectorsPage() {
  const params = useParams();
  const projectId = params.projectId as string;
  const access = useProjectSettingsAccess(projectId, "detectors");
  const { data: project } = useProject(projectId);

  return (
    <div className="flex h-full">
      <ProjectBreadcrumb projectId={projectId} current="Settings" />

      <SettingsLayout
        tabs={PROJECT_SETTINGS_TABS}
        activeTab="detectors"
        access={access}
        basePath={`/projects/${projectId}/settings`}
        crossLink={
          project?.workspace_id
            ? {
                label: "Org Settings",
                href: `/workspaces/${project.workspace_id}/settings/general`,
              }
            : undefined
        }
      >
        <DetectorsTab projectId={projectId} />
      </SettingsLayout>
    </div>
  );
}
