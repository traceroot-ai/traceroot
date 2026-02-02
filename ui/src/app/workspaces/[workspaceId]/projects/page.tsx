"use client";

import { useEffect } from "react";
import { useRouter, useParams } from "next/navigation";
import { useSession } from "next-auth/react";
import Link from "next/link";
import { FolderKanban, ChevronRight } from "lucide-react";
import { useLayout } from "@/components/layout/app-layout";
import { CreateProjectDialog, ProjectCard } from "@/features/projects/components";
import { useWorkspace } from "@/features/workspaces/hooks";

export default function ProjectsPage() {
  const router = useRouter();
  const params = useParams();
  const workspaceId = params.workspaceId as string;
  const { data: session, status } = useSession();
  const user = session?.user;
  const { setHeaderContent } = useLayout();

  useEffect(() => {
    if (!user) {
      router.push("/");
    }
  }, [user, router]);

  // Get workspace with projects
  const { data: workspace, isLoading } = useWorkspace(workspaceId, status === "authenticated");

  // Set header content
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
        <span className="font-medium">{workspace?.name || "..."}</span>
      </div>
    );
    return () => setHeaderContent(null);
  }, [setHeaderContent, workspace]);

  if (!user) {
    return null;
  }

  const projects = workspace?.projects || [];

  return (
    <div className="h-full bg-background overflow-auto">
      <div className="p-4">
        {/* Section header with title and button */}
        <div className="flex items-start justify-between mb-4">
          <div>
            <h1 className="text-lg font-semibold">Projects</h1>
            <p className="text-[13px] text-muted-foreground">View and manage projects in this workspace</p>
          </div>
          <CreateProjectDialog workspaceId={workspaceId} />
        </div>

        {/* Loading State */}
        {isLoading && (
          <div className="flex items-center justify-center py-12">
            <p className="text-muted-foreground text-[13px]">Loading projects...</p>
          </div>
        )}

        {/* Empty State */}
        {!isLoading && projects.length === 0 && (
          <div className="flex items-center justify-center py-16">
            <div className="flex flex-col items-center justify-center">
              <div className="flex h-12 w-12 items-center justify-center rounded-full bg-muted mb-4">
                <FolderKanban className="h-6 w-6 text-muted-foreground" />
              </div>
              <h3 className="font-medium mb-1 text-[13px]">No projects yet</h3>
              <p className="text-[12px] text-muted-foreground text-center">
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
