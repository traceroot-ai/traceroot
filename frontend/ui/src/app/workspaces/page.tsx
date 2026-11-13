"use client";

import { formatDate } from "@/lib/utils";
import { PageHeader } from "@/components/layout/page-header";
import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { authClient } from "@/lib/auth-client";
import Link from "next/link";
import { Building2, Settings } from "lucide-react";
import { TR } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { isDemoWorkspaceViewer } from "@/features/workspaces/utils";
import { CreateWorkspaceDialog } from "@/features/workspaces/components";
import { useWorkspaces } from "@/features/workspaces/hooks";

// Refresh ingestion dates while this page is visible.
const WORKSPACE_REFRESH_MS = 30_000;

export default function WorkspacesPage() {
  const router = useRouter();
  const { data: session, isPending } = authClient.useSession();
  const user = session?.user;

  useEffect(() => {
    if (!user) {
      router.push("/");
    }
  }, [user, router]);

  // Get all workspaces
  const { data: workspaces, isLoading } = useWorkspaces(!!session, WORKSPACE_REFRESH_MS);

  if (!user) {
    return null;
  }

  return (
    <div className="flex h-full flex-col overflow-hidden bg-background">
      {/* Title row: same pattern as every list page */}
      <PageHeader title="Workspaces" actions={<CreateWorkspaceDialog />} />

      <div className="min-w-0 flex-1 overflow-auto">
        {isLoading && (
          <div className="flex items-center justify-center py-12">
            <p className="text-[13px] text-muted-foreground">Loading workspaces...</p>
          </div>
        )}

        {!isLoading && (!workspaces || workspaces.length === 0) && (
          <div className="flex items-center justify-center py-16">
            <div className="flex flex-col items-center justify-center">
              <Building2 className="mb-3 h-5 w-5 text-muted-foreground" />
              <h3 className="mb-1 text-[13px] font-medium">No workspaces yet</h3>
              <p className="mb-4 text-center text-[12px] text-muted-foreground">
                Create your first workspace to get started
              </p>
              <CreateWorkspaceDialog />
            </div>
          </div>
        )}

        {!isLoading && workspaces && workspaces.length > 0 && (
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
              {workspaces.map((workspace) => (
                <TR
                  key={workspace.id}
                  interactive
                  onClick={() => router.push(`/workspaces/${workspace.id}/projects`)}
                >
                  <td className="whitespace-nowrap px-3 text-foreground">
                    <span className="flex items-center gap-2">
                      {workspace.name}
                      {isDemoWorkspaceViewer(workspace) && (
                        <Badge variant="outline">View only</Badge>
                      )}
                    </span>
                  </td>
                  <td className="whitespace-nowrap px-3 text-muted-foreground">
                    {workspace.is_demo ? "—" : formatDate(workspace.create_time)}
                  </td>
                  <td className="whitespace-nowrap px-3 text-muted-foreground">
                    {!workspace.is_demo && workspace.last_ingested_at
                      ? formatDate(workspace.last_ingested_at)
                      : "—"}
                  </td>
                  <td className="px-2 text-right">
                    <Link
                      href={`/workspaces/${workspace.id}/settings`}
                      onClick={(e) => e.stopPropagation()}
                      aria-label={`Settings for ${workspace.name}`}
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
