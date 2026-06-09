"use client";

import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import { useLayout } from "@/components/layout/app-layout";
import { Breadcrumb, BreadcrumbItem } from "@/components/layout/breadcrumb";
import { useProject } from "../hooks";
import { projectSwitchHref } from "../utils";
import { CreateProjectDialog } from "./CreateProjectDialog";
import { CreateWorkspaceDialog } from "@/features/workspaces/components";
import { useWorkspace, useWorkspaces } from "@/features/workspaces/hooks";
import { workspaceSwitchHref } from "@/features/workspaces/utils";

interface ProjectBreadcrumbProps {
  projectId: string;
  /** Final breadcrumb text (e.g., "Settings", trace name). If provided, project becomes a link. */
  current?: string;
}

/**
 * Breadcrumb component for project context pages.
 * Automatically fetches project and workspace data and sets the header.
 * The workspace and project segments are dropdown selectors for quick
 * switching and creation; selecting a project keeps the current sub-page
 * where sensible.
 *
 * Usage:
 * ```tsx
 * <ProjectBreadcrumb projectId={projectId} />
 * <ProjectBreadcrumb projectId={projectId} current="Settings" />
 * <ProjectBreadcrumb projectId={projectId} current={trace?.name} />
 * ```
 */
export function ProjectBreadcrumb({ projectId, current }: ProjectBreadcrumbProps) {
  const { setHeaderContent } = useLayout();
  const pathname = usePathname();
  const { data: project } = useProject(projectId);
  const { data: workspaces } = useWorkspaces();
  const { data: workspace } = useWorkspace(project?.workspace_id || "", !!project?.workspace_id);
  const [createWorkspaceOpen, setCreateWorkspaceOpen] = useState(false);
  const [createProjectOpen, setCreateProjectOpen] = useState(false);

  useEffect(() => {
    const breadcrumbItems: BreadcrumbItem[] = [
      { label: "Workspaces", href: "/workspaces" },
      {
        label: workspace?.name || "...",
        href: project?.workspace_id ? `/workspaces/${project.workspace_id}/projects` : undefined,
        options: workspaces?.map((ws) => ({
          id: ws.id,
          label: ws.name,
          href: workspaceSwitchHref(pathname, ws.id),
        })),
        selectedId: project?.workspace_id,
        createNew: { label: "New workspace", onSelect: () => setCreateWorkspaceOpen(true) },
      },
      {
        label: project?.name || "...",
        href: current ? `/projects/${projectId}/traces` : undefined,
        options: workspace?.projects?.map((p) => ({
          id: p.id,
          label: p.name,
          href: projectSwitchHref(pathname, p.id),
        })),
        selectedId: projectId,
        createNew: { label: "New project", onSelect: () => setCreateProjectOpen(true) },
      },
    ];

    if (current) {
      breadcrumbItems.push({ label: current });
    }

    setHeaderContent(<Breadcrumb items={breadcrumbItems} />);
    return () => setHeaderContent(null);
  }, [setHeaderContent, project, workspace, workspaces, projectId, current, pathname]);

  return (
    <>
      <CreateWorkspaceDialog open={createWorkspaceOpen} onOpenChange={setCreateWorkspaceOpen} />
      {project?.workspace_id && (
        <CreateProjectDialog
          workspaceId={project.workspace_id}
          open={createProjectOpen}
          onOpenChange={setCreateProjectOpen}
        />
      )}
    </>
  );
}
