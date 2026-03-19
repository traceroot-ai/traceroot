"use client";

import { useEffect } from "react";
import { useRouter, useParams } from "next/navigation";
import { authClient } from "@/lib/auth-client";
import { FolderKanban } from "lucide-react";
import { WorkspaceBreadcrumb } from "@/features/workspaces/components";
import { CreateProjectDialog, ProjectCard } from "@/features/projects/components";
import { useWorkspace } from "@/features/workspaces/hooks";

export default function ProjectsPage() {
  const router = useRouter();
  const params = useParams();
  const workspaceId = params.workspaceId as string;
  const { data: session, isPending } = authClient.useSession();
  const user = session?.user;

  useEffect(() => {
    if (!user) {
      router.push("/");
    }
  }, [user, router]);

  // Get workspace with projects
  const { data: workspace, isLoading } = useWorkspace(workspaceId, !!session);

  if (!user) {
    return null;
  }

  const projects = workspace?.projects || [];

  return (
    <div className="h-full overflow-auto bg-background">
      <WorkspaceBreadcrumb workspaceId={workspaceId} />

      <div className="p-4">
        {/* Section header with title and button */}
        <div className="mb-4 flex items-start justify-between">
          <div>
            <h1 className="text-lg font-semibold">Projects</h1>
            <p className="text-[13px] text-muted-foreground">
              View and manage projects in this workspace
            </p>
          </div>
          <CreateProjectDialog workspaceId={workspaceId} />
        </div>

        {/* Loading State */}
        {isLoading && (
          <div className="flex items-center justify-center py-12">
            <p className="text-[13px] text-muted-foreground">Loading projects...</p>
          </div>
        )}

        {/* Empty State */}
        {!isLoading && projects.length === 0 && (
          <div className="flex items-center justify-center py-16">
            <div className="flex flex-col items-center justify-center">
              <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-muted">
                <FolderKanban className="h-6 w-6 text-muted-foreground" />
              </div>
              <h3 className="mb-1 text-[13px] font-medium">No projects yet</h3>
              <p className="text-center text-[12px] text-muted-foreground">
                Create your first project to start tracking traces
              </p>
            </div>
          </div>
        )}

        {/* Projects Grid */}
        {!isLoading && projects.length > 0 && (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {projects.map((project) => (
              <ProjectCard key={project.id} project={project} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
