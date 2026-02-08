'use client'

import { useParams } from 'next/navigation'
import Link from 'next/link'
import { SlidersHorizontal, Users, CreditCard } from 'lucide-react'
import { cn } from '@/lib/utils'
import { WorkspaceBreadcrumb } from '@/features/workspaces/components'
import { BillingTab } from '@/features/settings/workspace'
import { useQuery } from '@tanstack/react-query'
import { getWorkspace } from '@/lib/api'
import type { PlanType } from '@traceroot/core'

const settingsTabs = [
  { id: 'general', label: 'General', icon: SlidersHorizontal, href: 'general' },
  { id: 'members', label: 'Members', icon: Users, href: 'members' },
  { id: 'billing', label: 'Billing', icon: CreditCard, href: 'billing' },
] as const

export default function WorkspaceSettingsBillingPage() {
  const params = useParams()
  const workspaceId = params.workspaceId as string

  const { data: workspace, isLoading } = useQuery({
    queryKey: ['workspace', workspaceId],
    queryFn: () => getWorkspace(workspaceId),
  })

  return (
    <div className="flex h-full">
      <WorkspaceBreadcrumb workspaceId={workspaceId} current="Settings" />

      <nav className="w-40 border-r">
        <ul>
          {settingsTabs.map((tab) => {
            const Icon = tab.icon
            return (
              <li key={tab.id}>
                <Link
                  href={`/workspaces/${workspaceId}/settings/${tab.href}`}
                  className={cn(
                    'flex w-full items-center gap-2 px-3 py-2 text-[13px] transition-colors',
                    tab.id === 'billing'
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

      <div className="flex-1 overflow-auto p-6">
        {isLoading ? (
          <div className="text-sm text-muted-foreground">Loading...</div>
        ) : (
          <BillingTab
            workspaceId={workspaceId}
            currentPlan={(workspace?.plan as PlanType) || 'free'}
            hasSubscription={!!workspace?.stripeSubscriptionId}
          />
        )}
      </div>
    </div>
  )
}
