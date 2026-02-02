'use client'

import { useState } from 'react'
import { useParams } from 'next/navigation'
import { SlidersHorizontal, Key } from 'lucide-react'
import { cn } from '@/lib/utils'
import { GeneralTab, AccessKeysTab } from '@/features/settings/project'

const settingsTabs = [
  { id: 'general', label: 'General', icon: SlidersHorizontal },
  { id: 'api-keys', label: 'API Keys', icon: Key },
] as const

type TabId = (typeof settingsTabs)[number]['id']

export default function SettingsPage() {
  const params = useParams()
  const projectId = params.projectId as string
  const [activeTab, setActiveTab] = useState<TabId>('general')

  return (
    <div className="flex h-full">
      <nav className="w-40 border-r">
        <ul>
          {settingsTabs.map((tab) => {
            const Icon = tab.icon
            return (
              <li key={tab.id}>
                <button
                  onClick={() => setActiveTab(tab.id)}
                  className={cn(
                    'flex w-full items-center gap-2 px-3 py-2 text-[13px] transition-colors',
                    activeTab === tab.id
                      ? 'bg-muted'
                      : 'hover:bg-muted/50'
                  )}
                >
                  <Icon className="h-3.5 w-3.5" />
                  {tab.label}
                </button>
              </li>
            )
          })}
        </ul>
      </nav>

      <div className="flex-1 overflow-auto p-4">
        <div>
          {activeTab === 'general' && <GeneralTab projectId={projectId} />}
          {activeTab === 'api-keys' && <AccessKeysTab projectId={projectId} />}
        </div>
      </div>
    </div>
  )
}
