"use client";

import { useParams } from "next/navigation";
import { LabelsTab } from "@/features/settings/project/components/LabelsTab";
import { ProjectSettingsLayout } from "@/features/settings/scoped-settings-layout";

export default function ProjectSettingsLabelsPage() {
  const { projectId } = useParams<{ projectId: string }>();

  return (
    <ProjectSettingsLayout projectId={projectId} tab="labels">
      <LabelsTab projectId={projectId} />
    </ProjectSettingsLayout>
  );
}
