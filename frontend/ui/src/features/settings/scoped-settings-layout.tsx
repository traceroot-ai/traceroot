"use client";

// The settings frame for a workspace or a project page: breadcrumb, tab menu,
// and the demo-viewer access for the tab (see demo-access.tsx). A page only
// names its id and tab.
import { type ReactNode } from "react";
import { ProjectBreadcrumb } from "@/features/projects/components";
import { useProject } from "@/features/projects/hooks";
import { WorkspaceBreadcrumb } from "@/features/workspaces/components";
import { useWorkspace } from "@/features/workspaces/hooks";
import { SettingsAccessGate, projectSettingsAccess, workspaceSettingsAccess } from "./demo-access";
import {
  PROJECT_SETTINGS_TABS,
  type ProjectSettingsTab,
  SettingsLayout,
  WORKSPACE_SETTINGS_TABS,
  type WorkspaceSettingsTab,
} from "./settings-layout";

// If the membership cannot be read, both layouts show the page as before and
// let the page and its API calls deal with the error, rather than an empty screen.

export function WorkspaceSettingsLayout({
  workspaceId,
  tab,
  children,
}: {
  workspaceId: string;
  tab: WorkspaceSettingsTab;
  children: ReactNode;
}) {
  const { data: workspace, isError } = useWorkspace(workspaceId);
  const access = isError ? { mode: "full" as const } : workspaceSettingsAccess(tab, workspace);

  return (
    <div className="flex h-full">
      <WorkspaceBreadcrumb workspaceId={workspaceId} current="Settings" />

      <SettingsLayout
        tabs={WORKSPACE_SETTINGS_TABS}
        activeTab={tab}
        basePath={`/workspaces/${workspaceId}/settings`}
      >
        <SettingsAccessGate access={access}>{children}</SettingsAccessGate>
      </SettingsLayout>
    </div>
  );
}

export function ProjectSettingsLayout({
  projectId,
  tab,
  children,
}: {
  projectId: string;
  tab: ProjectSettingsTab;
  children: ReactNode;
}) {
  const { data: project, isError: projectError } = useProject(projectId);
  const workspaceId = project?.workspace_id;
  const { data: workspace, isError } = useWorkspace(workspaceId ?? "");
  const access =
    projectError || isError ? { mode: "full" as const } : projectSettingsAccess(tab, workspace);

  return (
    <div className="flex h-full">
      <ProjectBreadcrumb projectId={projectId} current="Settings" />

      <SettingsLayout
        tabs={PROJECT_SETTINGS_TABS}
        activeTab={tab}
        basePath={`/projects/${projectId}/settings`}
        crossLink={
          workspaceId
            ? { label: "Org Settings", href: `/workspaces/${workspaceId}/settings/general` }
            : undefined
        }
      >
        <SettingsAccessGate access={access}>{children}</SettingsAccessGate>
      </SettingsLayout>
    </div>
  );
}
