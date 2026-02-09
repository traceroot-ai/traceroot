"use client";

import { useEffect } from "react";
import { useLayout } from "@/components/layout/app-layout";
import { Breadcrumb, BreadcrumbItem } from "@/components/layout/breadcrumb";
import { useProject } from "../hooks";
import { useWorkspace } from "@/features/workspaces/hooks";

interface ProjectBreadcrumbProps {
  projectId: string;
  /** Final breadcrumb text (e.g., "Settings", trace name). If provided, project becomes a link. */
  current?: string;
}

/**
 * Breadcrumb component for project context pages.
 * Automatically fetches project and workspace data and sets the header.
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
  const { data: project } = useProject(projectId);
  const { data: workspace } = useWorkspace(project?.workspace_id || "", !!project?.workspace_id);

  useEffect(() => {
    const breadcrumbItems: BreadcrumbItem[] = [
      { label: "Workspaces", href: "/workspaces" },
      {
        label: workspace?.name || "...",
        href: `/workspaces/${project?.workspace_id}/projects`,
      },
      {
        label: project?.name || "...",
        href: current ? `/projects/${projectId}/traces` : undefined,
      },
    ];

    if (current) {
      breadcrumbItems.push({ label: current });
    }

    setHeaderContent(<Breadcrumb items={breadcrumbItems} />);
    return () => setHeaderContent(null);
  }, [setHeaderContent, project, workspace, projectId, current]);

  return null;
}
