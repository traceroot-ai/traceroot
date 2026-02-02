'use client'

import { useEffect } from 'react'
import Link from 'next/link'
import { ChevronRight } from 'lucide-react'
import { useLayout } from './app-layout'
import { useProject } from '@/features/projects/hooks'
import { useWorkspace } from '@/features/workspaces/hooks'

export interface BreadcrumbItem {
  label: string
  href?: string
}

interface BreadcrumbProps {
  items: BreadcrumbItem[]
}

/**
 * Generic breadcrumb renderer
 */
export function Breadcrumb({ items }: BreadcrumbProps) {
  return (
    <div className="flex items-center gap-1.5 text-[13px]">
      {items.map((item, index) => (
        <span key={index} className="flex items-center gap-1.5">
          {index > 0 && (
            <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
          )}
          {item.href ? (
            <Link href={item.href} className="hover:underline">
              {item.label}
            </Link>
          ) : (
            <span className="font-medium">{item.label}</span>
          )}
        </span>
      ))}
    </div>
  )
}

interface ProjectBreadcrumbProps {
  projectId: string
  /** Final breadcrumb text (e.g., "Settings", trace name). If provided, project becomes a link. */
  current?: string
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
  const { setHeaderContent } = useLayout()
  const { data: project } = useProject(projectId)
  const { data: workspace } = useWorkspace(project?.workspace_id || '', !!project?.workspace_id)

  useEffect(() => {
    const breadcrumbItems: BreadcrumbItem[] = [
      { label: 'Workspaces', href: '/workspaces' },
      {
        label: workspace?.name || '...',
        href: `/workspaces/${project?.workspace_id}/projects`
      },
      {
        label: project?.name || '...',
        href: current ? `/projects/${projectId}/traces` : undefined
      },
    ]

    if (current) {
      breadcrumbItems.push({ label: current })
    }

    setHeaderContent(<Breadcrumb items={breadcrumbItems} />)
    return () => setHeaderContent(null)
  }, [setHeaderContent, project, workspace, projectId, current])

  return null
}

interface WorkspaceBreadcrumbProps {
  workspaceId: string
  /** Final breadcrumb text (e.g., "Settings"). If provided, workspace becomes a link. */
  current?: string
}

/**
 * Breadcrumb component for workspace context pages.
 * Automatically fetches workspace data and sets the header.
 *
 * Usage:
 * ```tsx
 * <WorkspaceBreadcrumb workspaceId={workspaceId} />
 * <WorkspaceBreadcrumb workspaceId={workspaceId} current="Settings" />
 * ```
 */
export function WorkspaceBreadcrumb({ workspaceId, current }: WorkspaceBreadcrumbProps) {
  const { setHeaderContent } = useLayout()
  const { data: workspace } = useWorkspace(workspaceId)

  useEffect(() => {
    const breadcrumbItems: BreadcrumbItem[] = [
      { label: 'Workspaces', href: '/workspaces' },
      {
        label: workspace?.name || '...',
        href: current ? `/workspaces/${workspaceId}/projects` : undefined
      },
    ]

    if (current) {
      breadcrumbItems.push({ label: current })
    }

    setHeaderContent(<Breadcrumb items={breadcrumbItems} />)
    return () => setHeaderContent(null)
  }, [setHeaderContent, workspace, workspaceId, current])

  return null
}
