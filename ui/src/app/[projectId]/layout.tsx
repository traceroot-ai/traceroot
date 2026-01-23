'use client'

import Link from 'next/link'
import { usePathname, useParams } from 'next/navigation'
import { cn } from '@/lib/utils'
import { Activity, Settings, Key } from 'lucide-react'

const projectNavigation = [
  { name: 'Traces', href: 'traces', icon: Activity },
  { name: 'Settings', href: 'settings', icon: Settings },
]

export default function ProjectLayout({
  children,
}: {
  children: React.ReactNode
}) {
  const pathname = usePathname()
  const params = useParams()
  const projectId = params.projectId as string

  return (
    <div className="flex h-full flex-col">
      {/* Project navigation */}
      <div className="border-b">
        <div className="flex h-14 items-center gap-6 px-6">
          <Link
            href="/projects"
            className="text-sm text-muted-foreground hover:text-foreground"
          >
            Projects
          </Link>
          <span className="text-muted-foreground">/</span>
          <span className="font-medium">{projectId.substring(0, 8)}...</span>
        </div>
        <nav className="flex gap-4 px-6">
          {projectNavigation.map((item) => {
            const href = `/${projectId}/${item.href}`
            const isActive = pathname.includes(`/${item.href}`)
            return (
              <Link
                key={item.name}
                href={href}
                className={cn(
                  'flex items-center gap-2 border-b-2 px-1 pb-3 text-sm font-medium transition-colors',
                  isActive
                    ? 'border-primary text-foreground'
                    : 'border-transparent text-muted-foreground hover:text-foreground'
                )}
              >
                <item.icon className="h-4 w-4" />
                {item.name}
              </Link>
            )
          })}
        </nav>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-auto">{children}</div>
    </div>
  )
}
