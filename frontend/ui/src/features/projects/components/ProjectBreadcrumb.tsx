"use client";

import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import { useLayout } from "@/components/layout/app-layout";
import { Breadcrumb, type BreadcrumbItem } from "@/components/layout/breadcrumb";
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
  /**
   * Intermediate segments between the project and `current`, for nested pages —
   * e.g. `[{ label: "Datasets", href: ".../datasets" }]` on a dataset detail page,
   * so the trail reads Workspace / Project / Datasets / <name>. A plain segment is
   * a link; a segment with `options` renders as a dropdown selector (like the
   * workspace/project segments), e.g. to switch between datasets.
   */
  trail?: BreadcrumbItem[];
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
export function ProjectBreadcrumb({ projectId, current, trail }: ProjectBreadcrumbProps) {
  const { setHeaderContent } = useLayout();
  const pathname = usePathname();
  const { data: project } = useProject(projectId);
  const { data: workspaces } = useWorkspaces();
  const { data: workspace } = useWorkspace(project?.workspace_id || "", !!project?.workspace_id);
  const [createWorkspaceOpen, setCreateWorkspaceOpen] = useState(false);
  const [createProjectOpen, setCreateProjectOpen] = useState(false);
  // Depend on the trail's content, not its array identity, so an inline-literal
  // trail from a caller doesn't re-run the effect (and re-set the header) each render.
  const trailKey = JSON.stringify(trail ?? []);

  useEffect(() => {
    const breadcrumbItems: BreadcrumbItem[] = [
      {
        label: workspace?.name || "...",
        href: project?.workspace_id ? `/workspaces/${project.workspace_id}/projects` : undefined,
        options: workspaces?.map((ws) => ({
          id: ws.id,
          label: ws.name,
          href: workspaceSwitchHref(pathname, ws.id),
          isCurrent: ws.id === project?.workspace_id,
          settingsHref: `/workspaces/${ws.id}/settings`,
        })),
        menuHeader: { label: "Workspaces", href: "/workspaces" },
        createNew: { label: "New workspace", onSelect: () => setCreateWorkspaceOpen(true) },
      },
      {
        label: project?.name || "...",
        href: current || trail?.length ? `/projects/${projectId}/traces` : undefined,
        options: workspace?.projects?.map((p) => ({
          id: p.id,
          label: p.name,
          href: projectSwitchHref(pathname, p.id),
          isCurrent: p.id === projectId,
          settingsHref: `/projects/${p.id}/settings`,
        })),
        menuHeader: {
          label: "Projects",
          href: `/workspaces/${project?.workspace_id}/projects`,
        },
        createNew: { label: "New project", onSelect: () => setCreateProjectOpen(true) },
      },
    ];

    for (const segment of trail ?? []) {
      breadcrumbItems.push(segment);
    }

    if (current) {
      breadcrumbItems.push({ label: current });
    }

    setHeaderContent(<Breadcrumb items={breadcrumbItems} />);
    return () => setHeaderContent(null);
    // trailKey encodes `trail`'s content (see above); listing trail itself would churn.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [setHeaderContent, project, workspace, workspaces, projectId, current, trailKey, pathname]);

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
