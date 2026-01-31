'use client'

import { useEffect } from 'react'
import Link from 'next/link'
import { useParams } from 'next/navigation'
import { useQuery } from '@tanstack/react-query'
import { ChevronRight } from 'lucide-react'
import { useLayout } from '@/components/layout/app-layout'
import { getProject, getOrganization } from '@/lib/api'

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

  // Fetch organization details once we have the project
  const { data: org } = useQuery({
    queryKey: ['organization', project?.org_id],
    queryFn: () => getOrganization(project!.org_id),
    enabled: !!project?.org_id,
  })

  // Set header content with breadcrumb: Org Name > Project Name
  useEffect(() => {
    if (project) {
      setHeaderContent(
        <div className="flex items-center gap-1.5 text-sm">
          <Link
            href="/organizations"
            className="text-muted-foreground hover:text-foreground transition-colors"
          >
            {org?.name || 'Organization'}
          </Link>
          <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
          <span className="font-medium">{project.name}</span>
        </div>
      )
    }
    return () => setHeaderContent(null)
  }, [project, org, setHeaderContent])

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div className="flex-1 overflow-hidden">{children}</div>
    </div>
  )
}
