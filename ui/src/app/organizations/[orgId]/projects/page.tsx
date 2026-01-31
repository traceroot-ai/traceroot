"use client";

import { useEffect } from "react";
import { useRouter, useParams } from "next/navigation";
import { useSession } from "next-auth/react";
import { useQuery } from "@tanstack/react-query";
import { getOrganization, type Project } from "@/lib/api";
import { Card, CardContent } from "@/components/ui/card";
import { useLayout } from "@/components/layout/app-layout";
import { FolderKanban, Settings } from "lucide-react";
import Link from "next/link";
import { CreateProjectDialog } from "@/components/CreateProjectDialog";

function ProjectCard({ project }: { project: Project }) {
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
          Created {new Date(project.created_at).toLocaleDateString()}
        </div>
      </CardContent>
    </Card>
  );
}

export default function ProjectsPage() {
  const router = useRouter();
  const params = useParams();
  const orgId = params.orgId as string;
  const { data: session, status } = useSession();
  const user = session?.user;
  const { setHeaderContent } = useLayout();

  useEffect(() => {
    if (!user) {
      router.push("/");
    }
  }, [user, router]);

  // Get organization with projects
  const { data: org, isLoading } = useQuery({
    queryKey: ["organization", orgId],
    queryFn: () => getOrganization(orgId),
    enabled: status === "authenticated" && !!orgId,
  });

  // Set header content
  useEffect(() => {
    setHeaderContent(
      <div className="flex items-center gap-2 text-[13px]">
        <Link
          href="/organizations"
          className="hover:underline"
        >
          Organizations
        </Link>
        <span className="text-muted-foreground">/</span>
        <span className="font-medium">{org?.name || "..."}</span>
      </div>
    );
    return () => setHeaderContent(null);
  }, [setHeaderContent, org]);

  if (!user) {
    return null;
  }

  const projects = org?.projects || [];

  return (
    <div className="h-full bg-background overflow-auto">
      <div className="p-4">
        {/* Section header with title and button */}
        <div className="flex items-start justify-between mb-4">
          <div>
            <h1 className="text-lg font-semibold">Projects</h1>
            <p className="text-[13px] text-muted-foreground">View and manage projects in this organization</p>
          </div>
          <CreateProjectDialog orgId={orgId} />
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
