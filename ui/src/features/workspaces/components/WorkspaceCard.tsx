'use client';

import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { Settings } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import type { Workspace } from '@/types/api';

interface WorkspaceCardProps {
  workspace: Workspace;
}

/**
 * Card component for displaying a workspace in the grid
 */
export function WorkspaceCard({ workspace }: WorkspaceCardProps) {
  const router = useRouter();

  return (
    <Card
      className="cursor-pointer transition-all hover:shadow-md hover:border-foreground/20"
      onClick={() => router.push(`/workspaces/${workspace.id}/projects`)}
    >
      <CardContent className="p-4">
        <div className="flex items-start justify-between mb-3">
          <h3 className="font-medium text-[13px]">{workspace.name}</h3>
          <Link
            href={`/workspaces/${workspace.id}/settings`}
            onClick={(e) => e.stopPropagation()}
            className="p-1 hover:bg-muted rounded transition-colors"
          >
            <Settings className="h-3.5 w-3.5 text-muted-foreground" />
          </Link>
        </div>
        <div className="flex gap-4 text-[11px] text-muted-foreground">
          <span>Created {new Date(workspace.create_time).toLocaleDateString()}</span>
          {workspace.update_time && <span>Updated {new Date(workspace.update_time).toLocaleDateString()}</span>}
        </div>
      </CardContent>
    </Card>
  );
}
