"use client";

import { useParams } from "next/navigation";
import { GeneralTab } from "@/features/settings/project";
import { ProjectSettingsLayout } from "@/features/settings/scoped-settings-layout";

export default function ProjectSettingsGeneralPage() {
  const params = useParams();
  const projectId = params.projectId as string;

  return (
    <ProjectSettingsLayout projectId={projectId} tab="general">
      <GeneralTab projectId={projectId} />
    </ProjectSettingsLayout>
  );
}
