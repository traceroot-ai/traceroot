'use client';

import { useRouter } from 'next/navigation';
import { Settings } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import type { Project } from '@/types/api';

interface ProjectCardProps {
  project: Project;
}

/**
 * Card component for displaying a project in the grid
 */
export function ProjectCard({ project }: ProjectCardProps) {
  const router = useRouter();

  return (
    <Card
      className="cursor-pointer transition-all hover:shadow-md hover:border-foreground/20"
      onClick={() => router.push(`/${project.id}/traces`)}
    >
      <CardContent className="p-4">
        <div className="flex items-start justify-between mb-3">
          <h3 className="font-medium text-[13px]">{project.name}</h3>
          <button
            onClick={(e) => {
              e.stopPropagation();
              router.push(`/${project.id}/settings`);
            }}
            className="p-1 hover:bg-muted rounded transition-colors"
          >
            <Settings className="h-3.5 w-3.5 text-muted-foreground" />
          </button>
        </div>
        <div className="text-[11px] text-muted-foreground">
          Created {new Date(project.create_time).toLocaleDateString()}
        </div>
      </CardContent>
    </Card>
  );
}
