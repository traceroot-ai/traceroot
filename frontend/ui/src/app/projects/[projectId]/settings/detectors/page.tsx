"use client";

import { useParams } from "next/navigation";
import { DetectorsTab } from "@/features/settings/project";
import { ProjectSettingsLayout } from "@/features/settings/scoped-settings-layout";

export default function ProjectSettingsDetectorsPage() {
  const params = useParams();
  const projectId = params.projectId as string;

  return (
    <ProjectSettingsLayout projectId={projectId} tab="detectors">
      <DetectorsTab projectId={projectId} />
    </ProjectSettingsLayout>
  );
}
