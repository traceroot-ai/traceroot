'use client'

import { useEffect } from 'react'
import { Github, BookOpen, MessageCircle } from 'lucide-react'
import { useLayout } from '@/components/layout/app-layout'

const supportChannels = [
  {
    id: 'documentation',
    title: 'Documentation',
    description: 'Tutorials and guides to get started.',
    icon: BookOpen,
    href: 'https://docs.traceroot.ai',
    external: true,
  },
  {
    id: 'github-issues',
    title: 'GitHub Issues',
    description: 'Report bugs or request new features.',
    icon: Github,
    href: 'https://github.com/traceroot-ai/traceroot/issues',
    external: true,
  },
  {
    id: 'discord',
    title: 'Discord',
    description: 'Chat with the community and team.',
    icon: MessageCircle,
    href: 'https://discord.com/invite/tPyffEZvvJ',
    external: true,
  },
]

export default function SupportPage() {
  const { setHeaderContent } = useLayout()

  // Set header breadcrumb
  useEffect(() => {
    setHeaderContent(
      <span className="text-[13px] font-medium">Support</span>
    )
    return () => setHeaderContent(null)
  }, [setHeaderContent])

  return (
    <div className="h-full bg-background overflow-auto">
      <div className="p-4">
        {/* Section header */}
        <div className="mb-4">
          <h1 className="text-lg font-semibold">Support</h1>
          <p className="text-[13px] text-muted-foreground">Get help and connect with us</p>
        </div>

        {/* Support channels grid */}
        <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
          {supportChannels.map((channel) => {
            const Icon = channel.icon
            return (
              <a
                key={channel.id}
                href={channel.href}
                target={channel.external ? '_blank' : undefined}
                rel={channel.external ? 'noopener noreferrer' : undefined}
                className="flex items-start gap-3 rounded-lg border border-border p-4 hover:bg-muted/50 transition-colors"
              >
                <Icon className="h-4 w-4 mt-0.5 shrink-0" />
                <div>
                  <h3 className="font-medium text-[13px]">{channel.title}</h3>
                  <p className="text-muted-foreground text-[12px] mt-0.5">
                    {channel.description}
                  </p>
                </div>
              </a>
            )
          })}
        </div>
      </div>
    </div>
  )
}
