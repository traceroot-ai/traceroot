'use client'

import { useEffect } from 'react'
import { useLayout } from '@/components/layout/app-layout'
import { Breadcrumb, BreadcrumbItem } from '@/components/layout/breadcrumb'
import { useWorkspace } from '../hooks'

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
