"use client";

import { useEffect } from "react";
import { useRouter, useParams } from "next/navigation";
import { authClient } from "@/lib/auth-client";
import { DOMAIN_ICONS } from "@/components/icons/domain-icons";
import { WorkspaceBreadcrumb } from "@/features/workspaces/components";
import Link from "next/link";
import { Settings } from "lucide-react";
import { TR } from "@/components/ui/table";
import { formatDate } from "@/lib/utils";
import { PageHeader } from "@/components/layout/page-header";
import { CreateProjectDialog } from "@/features/projects/components";
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
    <div className="flex h-full flex-col overflow-hidden bg-background">
      <WorkspaceBreadcrumb workspaceId={workspaceId} />
      <PageHeader title="Projects" actions={<CreateProjectDialog workspaceId={workspaceId} />} />

      <div className="min-w-0 flex-1 overflow-auto">
        {isLoading && (
          <div className="flex items-center justify-center py-12">
            <p className="text-[13px] text-muted-foreground">Loading projects...</p>
          </div>
        )}

        {!isLoading && projects.length === 0 && (
          <div className="flex items-center justify-center py-16">
            <div className="flex flex-col items-center justify-center">
              <DOMAIN_ICONS.project className="mb-3 h-5 w-5 text-muted-foreground" />
              <h3 className="mb-1 text-[13px] font-medium">No projects yet</h3>
              <p className="text-center text-[12px] text-muted-foreground">
                Create your first project to start tracking traces
              </p>
            </div>
          </div>
        )}

        {!isLoading && projects.length > 0 && (
          <table className="data-table w-full min-w-[32rem]">
            <thead>
              <tr>
                <th className="whitespace-nowrap px-3 text-left">Name</th>
                <th className="w-[10rem] whitespace-nowrap px-3 text-left">Created</th>
                <th className="w-[10rem] whitespace-nowrap px-3 text-left">Updated</th>
                <th className="w-[56px] px-2" aria-label="Settings" />
              </tr>
            </thead>
            <tbody>
              {projects.map((project) => (
                <TR
                  key={project.id}
                  interactive
                  onClick={() => router.push(`/projects/${project.id}/traces`)}
                >
                  <td className="whitespace-nowrap px-3 text-foreground">{project.name}</td>
                  <td className="whitespace-nowrap px-3 text-muted-foreground">
                    {workspace?.is_demo ? "—" : formatDate(project.create_time)}
                  </td>
                  <td className="whitespace-nowrap px-3 text-muted-foreground">
                    {!workspace?.is_demo && project.update_time
                      ? formatDate(project.update_time)
                      : "—"}
                  </td>
                  <td className="px-2 text-right">
                    <Link
                      href={`/projects/${project.id}/settings`}
                      onClick={(e) => e.stopPropagation()}
                      aria-label={`Settings for ${project.name}`}
                      className="inline-flex h-7 w-7 items-center justify-center rounded-[2px] transition-colors hover:bg-muted"
                    >
                      <Settings className="h-3.5 w-3.5 text-muted-foreground" />
                    </Link>
                  </td>
                </TR>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
