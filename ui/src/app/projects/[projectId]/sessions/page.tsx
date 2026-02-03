'use client'

import Link from 'next/link'
import { useParams } from 'next/navigation'
import { Workflow, Users, Layers } from 'lucide-react'
import { ProjectBreadcrumb } from '@/features/projects/components'
import { cn } from '@/lib/utils'

const tabs = [
  { id: 'traces', label: 'Traces', icon: Workflow, href: 'traces' },
  { id: 'sessions', label: 'Sessions', icon: Layers, href: 'sessions' },
  { id: 'users', label: 'Users', icon: Users, href: 'users' },
]

export default function SessionsPage() {
  const params = useParams()
  const projectId = params.projectId as string

  return (
    <div className="flex h-full relative text-[13px]">
      <ProjectBreadcrumb projectId={projectId} />

      {/* Main content */}
      <div className="flex-1 flex flex-col">
        {/* Tab navigation */}
        <div className="border-b bg-white">
          <div className="flex">
            {tabs.map((tab) => {
              const Icon = tab.icon
              const isActive = tab.id === 'sessions'
              return (
                <Link
                  key={tab.id}
                  href={`/projects/${projectId}/${tab.href}`}
                  className={cn(
                    'flex items-center gap-1.5 px-3 py-1.5 text-[13px] font-medium border-b-2 transition-colors',
                    isActive
                      ? 'border-gray-900 bg-muted'
                      : 'border-transparent hover:bg-muted/50'
                  )}
                >
                  <Icon className="h-3.5 w-3.5" />
                  {tab.label}
                </Link>
              )
            })}
          </div>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-auto bg-white">
          <div className="flex h-64 items-center justify-center flex-col gap-3">
            <Layers className="h-10 w-10 text-gray-400" />
            <p className="text-gray-500 text-[13px]">Sessions view coming soon</p>
          </div>
        </div>
      </div>
    </div>
  )
}
