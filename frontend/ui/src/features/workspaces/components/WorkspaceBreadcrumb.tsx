"use client";

import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import { useT } from "@/lib/i18n/provider";
import { useLayout } from "@/components/layout/app-layout";
import { Breadcrumb, BreadcrumbItem } from "@/components/layout/breadcrumb";
import { useWorkspace, useWorkspaces } from "../hooks";
import { workspaceSwitchHref } from "../utils";
import { CreateWorkspaceDialog } from "./CreateWorkspaceDialog";

interface WorkspaceBreadcrumbProps {
  workspaceId: string;
  /** Final breadcrumb text (e.g., "Settings"). If provided, workspace becomes a link. */
  current?: string;
}

/**
 * Breadcrumb component for workspace context pages.
 * Automatically fetches workspace data and sets the header.
 * The workspace segment is a dropdown selector for quick switching and
 * creation; selecting a workspace keeps the current sub-page.
 *
 * Usage:
 * ```tsx
 * <WorkspaceBreadcrumb workspaceId={workspaceId} />
 * <WorkspaceBreadcrumb workspaceId={workspaceId} current="Settings" />
 * ```
 */
export function WorkspaceBreadcrumb({ workspaceId, current }: WorkspaceBreadcrumbProps) {
  const t = useT();
  const { setHeaderContent } = useLayout();
  const pathname = usePathname();
  const { data: workspace } = useWorkspace(workspaceId);
  const { data: workspaces } = useWorkspaces();
  const [createWorkspaceOpen, setCreateWorkspaceOpen] = useState(false);

  useEffect(() => {
    const breadcrumbItems: BreadcrumbItem[] = [
      {
        label: workspace?.name || "...",
        href: current ? `/workspaces/${workspaceId}/projects` : undefined,
        options: workspaces?.map((ws) => ({
          id: ws.id,
          label: ws.name,
          href: workspaceSwitchHref(pathname, ws.id),
          isCurrent: ws.id === workspaceId,
          settingsHref: `/workspaces/${ws.id}/settings`,
        })),
        menuHeader: { label: t("workspaces.title"), href: "/workspaces" },
        createNew: {
          label: t("workspaces.newWorkspace"),
          onSelect: () => setCreateWorkspaceOpen(true),
        },
      },
    ];

    if (current) {
      breadcrumbItems.push({ label: current });
    }

    setHeaderContent(<Breadcrumb items={breadcrumbItems} />);
    return () => setHeaderContent(null);
  }, [setHeaderContent, workspace, workspaces, workspaceId, current, pathname, t]);

  return <CreateWorkspaceDialog open={createWorkspaceOpen} onOpenChange={setCreateWorkspaceOpen} />;
}
