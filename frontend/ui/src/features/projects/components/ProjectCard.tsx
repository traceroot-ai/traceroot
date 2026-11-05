"use client";

import { useRouter } from "next/navigation";
import { Settings } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import type { Project } from "@/types/api";

interface ProjectCardProps {
  project: Project;
  isDemo?: boolean;
}

/**
 * Card component for displaying a project in the grid
 */
export function ProjectCard({ project, isDemo = false }: ProjectCardProps) {
  const router = useRouter();

  return (
    <Card
      className="min-h-[85px] cursor-pointer transition-all hover:border-foreground/20 hover:shadow-md"
      onClick={() => router.push(`/projects/${project.id}/traces`)}
    >
      <CardContent className="p-4">
        <div className={`${isDemo ? "" : "mb-3"} flex items-start justify-between`}>
          <h3 className="text-[13px] font-medium">{project.name}</h3>
          <button
            onClick={(e) => {
              e.stopPropagation();
              router.push(`/projects/${project.id}/settings`);
            }}
            className="rounded p-1 transition-colors hover:bg-muted"
          >
            <Settings className="h-3.5 w-3.5 text-muted-foreground" />
          </button>
        </div>
        {!isDemo && (
          <div className="text-[11px] text-muted-foreground">
            Created {new Date(project.create_time).toLocaleDateString()}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
