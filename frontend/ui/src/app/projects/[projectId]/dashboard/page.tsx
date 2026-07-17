"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { MoreHorizontal, Pencil, Trash2 } from "lucide-react";
import { ProjectBreadcrumb } from "@/features/projects/components";
import { useDashboards } from "@/features/dashboards/hooks/use-dashboards";
import { CreateDashboardDialog } from "@/features/dashboards/components/CreateDashboardDialog";
import { DeleteDashboardDialog } from "@/features/dashboards/components/DeleteDashboardDialog";
import { EditDashboardDialog } from "@/features/dashboards/components/EditDashboardDialog";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { formatDate } from "@/lib/utils";

/**
 * The dashboards entry point. A project with a single dashboard (the common
 * case — the list endpoint lazily seeds the default Overview, so there is
 * always at least one) opens straight into it; with several, this renders a
 * list page in the house table style, one row per dashboard.
 */
export default function DashboardIndexPage() {
  const params = useParams();
  const router = useRouter();
  const projectId = params.projectId as string;
  // The detail page's back link arrives with ?list=1: without it a project
  // with a single dashboard would auto-open right back, making the list (and
  // its "New dashboard" button) unreachable from a sole dashboard.
  const wantList = useSearchParams().has("list");
  const { data: dashboards, error, refetch } = useDashboards(projectId);

  const [createOpen, setCreateOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<{
    id: string;
    name: string;
    description: string | null;
  } | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<{ id: string; name: string } | null>(null);
  const [actionsOpen, setActionsOpen] = useState<string | null>(null);

  // Auto-open applies on ENTRY only: once the list has been shown, deleting
  // down to one row must not yank the user into the survivor mid-interaction.
  const [listPinned, setListPinned] = useState(false);
  // One derivation drives both the redirect effect and the loading branch
  // below, so they can't drift apart.
  const autoOpening = !!dashboards && dashboards.length === 1 && !wantList && !listPinned;
  useEffect(() => {
    if (!dashboards || dashboards.length === 0) return;
    if (autoOpening) router.replace(`/projects/${projectId}/dashboard/${dashboards[0].id}`);
    else setListPinned(true);
  }, [autoOpening, dashboards, projectId, router]);

  if (error) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 text-[13px]">
        <span className="text-destructive">Failed to load dashboards — retry</span>
        <button
          type="button"
          onClick={() => void refetch()}
          className="rounded border border-border px-3 py-1 text-[12px] text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          Retry
        </button>
      </div>
    );
  }

  // Loading, or a single dashboard about to be auto-opened by the effect.
  if (!dashboards || dashboards.length === 0 || autoOpening) {
    return (
      <div className="flex h-full items-center justify-center text-[13px] text-muted-foreground">
        Loading dashboards…
      </div>
    );
  }

  return (
    <div className="relative flex h-full text-[13px]">
      <ProjectBreadcrumb projectId={projectId} />

      <CreateDashboardDialog projectId={projectId} open={createOpen} onOpenChange={setCreateOpen} />

      {/* The dialog seeds its drafts on mount, so callers must key it by the
          target's id to reset them per row. */}
      <EditDashboardDialog
        key={editTarget?.id ?? "closed"}
        projectId={projectId}
        target={editTarget}
        onClose={() => setEditTarget(null)}
      />

      <DeleteDashboardDialog
        projectId={projectId}
        target={deleteTarget}
        onClose={() => setDeleteTarget(null)}
      />

      <div className="flex flex-1 flex-col overflow-hidden">
        {/* Page header */}
        <div className="flex h-[45px] shrink-0 items-center justify-between border-b border-border px-4">
          <h1 className="text-[13px] font-medium">Dashboards</h1>
          <Button size="sm" className="h-7 text-[12px]" onClick={() => setCreateOpen(true)}>
            ＋ New dashboard
          </Button>
        </div>

        {/* List */}
        <div className="flex-1 overflow-auto bg-background">
          <table className="w-full">
            <thead className="sticky top-0 bg-background">
              <tr className="border-b border-border bg-muted/50">
                <th className="w-[16rem] border-r border-border/50 px-3 py-1.5 text-left text-[12px] font-medium text-muted-foreground">
                  Name
                </th>
                <th className="border-r border-border/50 px-3 py-1.5 text-left text-[12px] font-medium text-muted-foreground">
                  Description
                </th>
                <th className="w-[12rem] border-r border-border/50 px-3 py-1.5 text-left text-[12px] font-medium text-muted-foreground">
                  Owner
                </th>
                <th className="w-[10rem] border-r border-border/50 px-3 py-1.5 text-left text-[12px] font-medium text-muted-foreground">
                  Created
                </th>
                <th className="w-[10rem] border-r border-border/50 px-3 py-1.5 text-left text-[12px] font-medium text-muted-foreground">
                  Updated
                </th>
                <th className="w-10 px-2 py-1.5" />
              </tr>
            </thead>
            <tbody>
              {dashboards.map((d) => (
                <tr
                  key={d.id}
                  onClick={() => router.push(`/projects/${projectId}/dashboard/${d.id}`)}
                  className="cursor-pointer border-b border-border/50 transition-colors last:border-0 hover:bg-muted/50"
                >
                  <td className="border-r border-border/50 px-3 py-1.5 text-[12px] text-foreground">
                    <span className="block truncate" title={d.name}>
                      {d.name}
                    </span>
                  </td>
                  <td className="border-r border-border/50 px-3 py-1.5 text-[12px] text-muted-foreground">
                    <span className="block truncate" title={d.description ?? undefined}>
                      {d.description || "—"}
                    </span>
                  </td>
                  <td className="border-r border-border/50 px-3 py-1.5 text-[12px] text-muted-foreground">
                    <span className="block truncate" title={d.creator ?? undefined}>
                      {d.creator ?? "—"}
                    </span>
                  </td>
                  <td className="border-r border-border/50 px-3 py-1.5 text-[12px] text-muted-foreground">
                    {formatDate(d.createTime)}
                  </td>
                  <td className="border-r border-border/50 px-3 py-1.5 text-[12px] text-muted-foreground">
                    {formatDate(d.updateTime)}
                  </td>
                  <td className="px-2 text-right">
                    <Popover
                      open={actionsOpen === d.id}
                      onOpenChange={(open) => setActionsOpen(open ? d.id : null)}
                    >
                      <PopoverTrigger asChild>
                        <Button
                          variant="ghost"
                          size="sm"
                          aria-label="Dashboard actions"
                          className="h-5 w-6 p-0 text-muted-foreground hover:text-foreground"
                          onClick={(e) => e.stopPropagation()}
                        >
                          <MoreHorizontal className="h-3.5 w-3.5" />
                        </Button>
                      </PopoverTrigger>
                      <PopoverContent align="end" className="w-36 p-1">
                        <button
                          className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-[12px] hover:bg-muted/60"
                          onClick={(e) => {
                            e.stopPropagation();
                            setEditTarget({ id: d.id, name: d.name, description: d.description });
                            setActionsOpen(null);
                          }}
                        >
                          <Pencil className="h-3.5 w-3.5 text-muted-foreground" />
                          Edit
                        </button>
                        <button
                          className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-[12px] text-destructive hover:bg-destructive/10"
                          onClick={(e) => {
                            e.stopPropagation();
                            setDeleteTarget({ id: d.id, name: d.name });
                            setActionsOpen(null);
                          }}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                          Delete
                        </button>
                      </PopoverContent>
                    </Popover>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
