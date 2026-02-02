'use client'

import { useEffect } from 'react'
import Link from 'next/link'
import { useParams } from 'next/navigation'
import { useQuery } from '@tanstack/react-query'
import { ChevronRight } from 'lucide-react'
import { useLayout } from '@/components/layout/app-layout'
import { getProject, getWorkspace } from '@/lib/api'

export default function ProjectLayout({
  children,
}: {
  children: React.ReactNode
}) {
  const params = useParams()
  const projectId = params.projectId as string
  const { setHeaderContent } = useLayout()

  // Fetch project details
  const { data: project } = useQuery({
    queryKey: ['project', projectId],
    queryFn: () => getProject(projectId),
    enabled: !!projectId,
  })

  // Fetch workspace details once we have the project
  const { data: workspace } = useQuery({
    queryKey: ['workspace', project?.workspace_id],
    queryFn: () => getWorkspace(project!.workspace_id),
    enabled: !!project?.workspace_id,
  })

  // Set header content with breadcrumb: Workspaces > Workspace Name > Project Name
  useEffect(() => {
    if (project) {
      setHeaderContent(
        <div className="flex items-center gap-1.5 text-[13px]">
          <Link
            href="/workspaces"
            className="hover:underline"
          >
            Workspaces
          </Link>
          <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
          <Link
            href={`/workspaces/${project.workspace_id}/projects`}
            className="hover:underline"
          >
            {workspace?.name || '...'}
          </Link>
          <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
          <span className="font-medium">{project.name}</span>
        </div>
      )
    }
    return () => setHeaderContent(null)
  }, [project, workspace, setHeaderContent])

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div className="flex-1 overflow-hidden">{children}</div>
    </div>
  )
}
