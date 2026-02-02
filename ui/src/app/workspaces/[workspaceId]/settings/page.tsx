'use client';

import { useState, useEffect } from 'react';
import { useParams, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { SlidersHorizontal, Users, CreditCard, ChevronRight } from 'lucide-react';
import { useLayout } from '@/components/layout/app-layout';
import { cn } from '@/lib/utils';
import { useWorkspace } from '@/features/workspaces/hooks';
import { GeneralTab, MembersTab, BillingTab } from '@/features/settings/workspace';

const settingsTabs = [
  { id: 'general', label: 'General', icon: SlidersHorizontal },
  { id: 'members', label: 'Members', icon: Users },
  { id: 'billing', label: 'Billing', icon: CreditCard },
] as const;

type TabId = (typeof settingsTabs)[number]['id'];

export default function WorkspaceSettingsPage() {
  const params = useParams();
  const searchParams = useSearchParams();
  const workspaceId = params.workspaceId as string;
  const { setHeaderContent } = useLayout();

  const initialTab = (searchParams.get('tab') as TabId) || 'general';
  const [activeTab, setActiveTab] = useState<TabId>(initialTab);

  const { data: workspace } = useWorkspace(workspaceId);

  useEffect(() => {
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
          href={`/workspaces/${workspaceId}/projects`}
          className="hover:underline"
        >
          {workspace?.name || '...'}
        </Link>
        <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
        <span className="font-medium">Settings</span>
      </div>
    );
    return () => setHeaderContent(null);
  }, [setHeaderContent, workspace?.name, workspaceId]);

  return (
    <div className="flex h-full">
      <nav className="w-40 border-r">
        <ul>
          {settingsTabs.map((tab) => {
            const Icon = tab.icon;
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
            );
          })}
        </ul>
      </nav>

      <div className="flex-1 overflow-auto p-6">
        <div>
          {activeTab === 'general' && <GeneralTab workspaceId={workspaceId} />}
          {activeTab === 'members' && <MembersTab workspaceId={workspaceId} />}
          {activeTab === 'billing' && <BillingTab workspaceId={workspaceId} />}
        </div>
      </div>
    </div>
  );
}
