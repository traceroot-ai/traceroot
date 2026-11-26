"use client";

import { useParams } from "next/navigation";
import { AccessKeysTab } from "@/features/settings/project";
import { ProjectSettingsLayout } from "@/features/settings/scoped-settings-layout";

export default function ProjectSettingsAccessKeysPage() {
  const params = useParams();
  const projectId = params.projectId as string;

  return (
    <ProjectSettingsLayout projectId={projectId} tab="accessKeys">
      <AccessKeysTab projectId={projectId} />
    </ProjectSettingsLayout>
  );
}
