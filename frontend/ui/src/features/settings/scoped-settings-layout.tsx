"use client";

// The settings frame for a workspace or a project page: breadcrumb, tab menu,
// and the demo-viewer access for the tab (see demo-access.tsx). A page only
// names its id and tab.
import { type ReactNode } from "react";
import Link from "next/link";
import { ApiError } from "@/lib/api/errors";
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

export function WorkspaceSettingsLayout({
  workspaceId,
  tab,
  children,
}: {
  workspaceId: string;
  tab: WorkspaceSettingsTab;
  children: ReactNode;
}) {
  const { data: workspace, error, refetch } = useWorkspace(workspaceId);
  if (error) {
    const unavailable = error instanceof ApiError && (error.status === 403 || error.status === 404);
    return (
      <div className="flex flex-col items-center gap-3 p-8 text-center">
        <h1 className="text-base font-medium">
          {unavailable ? "Workspace unavailable" : "Could not load workspace settings"}
        </h1>
        {unavailable ? (
          <Link href="/workspaces" className="text-[13px] text-brand hover:underline">
            Go to your workspaces
          </Link>
        ) : (
          <button onClick={() => void refetch()} className="text-[13px] text-brand hover:underline">
            Try again
          </button>
        )}
      </div>
    );
  }
  const access = workspaceSettingsAccess(tab, workspace);

  return (
    <div className="flex h-full">
      <WorkspaceBreadcrumb workspaceId={workspaceId} />

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
    projectError || isError
      ? {
          mode: "denied" as const,
          title: "Project settings unavailable",
          message: "Could not load project settings. Reload the page to try again.",
        }
      : projectSettingsAccess(tab, workspace);

  return (
    <div className="flex h-full">
      <ProjectBreadcrumb projectId={projectId} />

      <SettingsLayout
        tabs={PROJECT_SETTINGS_TABS}
        activeTab={tab}
        basePath={`/projects/${projectId}/settings`}
        crossLink={
          workspaceId
            ? { label: "Workspace", href: `/workspaces/${workspaceId}/settings/general` }
            : undefined
        }
      >
        <SettingsAccessGate access={access}>{children}</SettingsAccessGate>
      </SettingsLayout>
    </div>
  );
}
