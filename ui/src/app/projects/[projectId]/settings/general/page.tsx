'use client'

import { useParams } from 'next/navigation'
import Link from 'next/link'
import { SlidersHorizontal, Key } from 'lucide-react'
import { cn } from '@/lib/utils'
import { ProjectBreadcrumb } from '@/components/layout/breadcrumb'
import { GeneralTab } from '@/features/settings/project'

const settingsTabs = [
  { id: 'general', label: 'General', icon: SlidersHorizontal, href: 'general' },
  { id: 'accessKeys', label: 'API Keys', icon: Key, href: 'accessKeys' },
] as const

export default function ProjectSettingsGeneralPage() {
  const params = useParams()
  const projectId = params.projectId as string

  return (
    <div className="flex h-full">
      <ProjectBreadcrumb projectId={projectId} current="Settings" />

      <nav className="w-40 border-r">
        <ul>
          {settingsTabs.map((tab) => {
            const Icon = tab.icon
            return (
              <li key={tab.id}>
                <Link
                  href={`/projects/${projectId}/settings/${tab.href}`}
                  className={cn(
                    'flex w-full items-center gap-2 px-3 py-2 text-[13px] transition-colors',
                    tab.id === 'general'
                      ? 'bg-muted'
                      : 'hover:bg-muted/50'
                  )}
                >
                  <Icon className="h-3.5 w-3.5" />
                  {tab.label}
                </Link>
              </li>
            )
          })}
        </ul>
      </nav>

      <div className="flex-1 overflow-auto p-4">
        <GeneralTab projectId={projectId} />
      </div>
    </div>
  )
}
