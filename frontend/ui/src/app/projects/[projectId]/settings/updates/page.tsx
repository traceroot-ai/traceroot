"use client";

import { useParams } from "next/navigation";
import { UpdatesTab } from "@/features/settings/project";
import { ProjectSettingsLayout } from "@/features/settings/scoped-settings-layout";

export default function ProjectSettingsUpdatesPage() {
  const params = useParams();
  const projectId = params.projectId as string;

  return (
    <ProjectSettingsLayout projectId={projectId} tab="updates">
      <UpdatesTab projectId={projectId} />
    </ProjectSettingsLayout>
  );
}
