"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useSession } from "next-auth/react";
import { Building2 } from "lucide-react";
import { useLayout } from "@/components/layout/app-layout";
import { CreateWorkspaceDialog, WorkspaceCard } from "@/features/workspaces/components";
import { useWorkspaces } from "@/features/workspaces/hooks";

export default function WorkspacesPage() {
  const router = useRouter();
  const { data: session, status } = useSession();
  const user = session?.user;
  const { setHeaderContent } = useLayout();

  useEffect(() => {
    if (!user) {
      router.push("/");
    }
  }, [user, router]);

  // Set header content
  useEffect(() => {
    setHeaderContent(
      <span className="text-[13px] font-medium">Workspaces</span>
    );
    return () => setHeaderContent(null);
  }, [setHeaderContent]);

  // Get all workspaces
  const { data: workspaces, isLoading } = useWorkspaces(status === "authenticated");

  if (!user) {
    return null;
  }

  return (
    <div className="h-full bg-background overflow-auto">
      <div className="p-4">
        {/* Section header with title and button */}
        <div className="flex items-start justify-between mb-4">
          <div>
            <h1 className="text-lg font-semibold">Workspaces</h1>
            <p className="text-[13px] text-muted-foreground">Manage your workspaces and teams</p>
          </div>
          <CreateWorkspaceDialog />
        </div>

        {/* Loading State */}
        {isLoading && (
          <div className="flex items-center justify-center py-12">
            <p className="text-muted-foreground text-[13px]">Loading workspaces...</p>
          </div>
        )}

        {/* Empty State */}
        {!isLoading && (!workspaces || workspaces.length === 0) && (
          <div className="flex items-center justify-center py-16">
            <div className="flex flex-col items-center justify-center">
              <div className="flex h-12 w-12 items-center justify-center rounded-full bg-muted mb-4">
                <Building2 className="h-6 w-6 text-muted-foreground" />
              </div>
              <h3 className="font-medium mb-1 text-[13px]">No workspaces yet</h3>
              <p className="text-[12px] text-muted-foreground mb-4 text-center">
                Create your first workspace to get started
              </p>
              <CreateWorkspaceDialog />
            </div>
          </div>
        )}

        {/* Workspaces Grid */}
        {!isLoading && workspaces && workspaces.length > 0 && (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {workspaces.map((workspace) => (
              <WorkspaceCard key={workspace.id} workspace={workspace} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
