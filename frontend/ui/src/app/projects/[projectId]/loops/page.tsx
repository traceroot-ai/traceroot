"use client";

import { PageHeader } from "@/components/layout/page-header";
import { useRef, useState } from "react";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { LOOP_LIMITS } from "@traceroot/core/loops/pure";
import { Button } from "@/components/ui/button";
import { LoadingState } from "@/components/ui/loading-state";
import { ListPagination } from "@/components/list-pagination";
import { SearchFilterBar } from "@/components/search-filter-bar";
import { ProjectBreadcrumb } from "@/features/projects/components";
import { DeleteLoopDialog } from "@/features/loops/components/delete-loop-dialog";
import { LoopsEmpty } from "@/features/loops/components/loops-empty";
import { LoopsTable } from "@/features/loops/components/loops-table";
import {
  useDeleteLoop,
  useLoopList,
  useSetLoopStatus,
  type Loop,
} from "@/features/loops/hooks/use-loops";
import { useListPageState } from "@/lib/hooks/use-list-page-state";
import { useRememberListQuery } from "@/lib/hooks/use-list-return";
import { useScrollToTopOnChange } from "@/lib/hooks/use-scroll-to-top-on-change";

export default function LoopsPage() {
  const params = useParams();
  const router = useRouter();
  const projectId = params.projectId as string;

  const [deleteTarget, setDeleteTarget] = useState<{ id: string; name: string } | null>(null);

  const { state, queryOptions, updateKeyword, updateLimit, goToPage } = useListPageState();
  const searchParams = useSearchParams();
  useRememberListQuery(`loops:${projectId}`, searchParams.toString());

  const { data, isLoading, error } = useLoopList(projectId, {
    page: queryOptions.page,
    limit: queryOptions.limit,
    search_query: queryOptions.search_query,
  });

  const listRef = useRef<HTMLDivElement>(null);
  useScrollToTopOnChange(
    listRef,
    JSON.stringify([queryOptions.page, queryOptions.limit, queryOptions.search_query]),
  );

  const deleteMutation = useDeleteLoop(projectId);
  const statusMutation = useSetLoopStatus(projectId);

  const loops = data?.data ?? [];
  const meta = data?.meta;

  const isEmptyProject = !isLoading && !error && (meta?.total ?? 0) === 0 && !state.keyword;
  const isEmptySearch = !isLoading && !error && loops.length === 0 && !!state.keyword;
  // The splash is the whole page for a project with no Loops.
  const showListChrome = !isLoading && !error && !isEmptyProject;
  const atCapacity = !state.keyword && (meta?.total ?? 0) >= LOOP_LIMITS.loopsPerProject;

  // Anything not running is started again; only an active Loop is paused.
  const handleToggleStatus = (loop: Loop) =>
    statusMutation.mutate({
      loopId: loop.id,
      action: loop.status === "active" ? "pause" : "resume",
    });

  const handleDeleteConfirm = () => {
    if (!deleteTarget) return;
    deleteMutation.mutate(deleteTarget.id, { onSuccess: () => setDeleteTarget(null) });
  };

  return (
    <div className="relative flex h-full text-[13px]">
      <ProjectBreadcrumb projectId={projectId} />

      <div className="flex flex-1 flex-col overflow-hidden">
        <PageHeader
          title="Loops"
          actions={
            showListChrome ? (
              <>
                {atCapacity && (
                  <span className="text-[12px] text-muted-foreground">
                    {meta?.total} of {LOOP_LIMITS.loopsPerProject} Loops used
                  </span>
                )}
                <Button
                  size="sm"
                  disabled={atCapacity}
                  onClick={() => router.push(`/projects/${projectId}/loops/new`)}
                >
                  New Loop
                </Button>
              </>
            ) : undefined
          }
        />

        {showListChrome && (
          <SearchFilterBar searchValue={state.keyword} onSearchChange={updateKeyword} />
        )}

        <div ref={listRef} className="flex-1 overflow-auto bg-background">
          {isLoading ? (
            <div className="flex h-64 items-center justify-center">
              <LoadingState label="Loading Loops..." />
            </div>
          ) : error ? (
            <div className="flex h-64 flex-col items-center justify-center gap-3">
              <p className="text-[13px] text-destructive">Error loading Loops</p>
              <p className="max-w-md text-center text-[12px] text-muted-foreground">
                {error instanceof Error ? error.message : String(error)}
              </p>
            </div>
          ) : isEmptyProject ? (
            <LoopsEmpty projectId={projectId} />
          ) : isEmptySearch ? (
            <div className="flex h-64 flex-col items-center justify-center gap-3">
              <p className="text-[13px] text-muted-foreground">
                No Loops match &ldquo;{state.keyword}&rdquo;
              </p>
              <Button
                size="sm"
                variant="outline"
                className="h-7 text-[12px]"
                onClick={() => updateKeyword("")}
              >
                Clear search
              </Button>
            </div>
          ) : (
            <>
              {statusMutation.error && (
                <p className="border-b border-border px-4 py-2 text-[12px] text-destructive">
                  {statusMutation.error.message}
                </p>
              )}
              <LoopsTable
                loops={loops}
                projectId={projectId}
                onToggleStatus={handleToggleStatus}
                onDelete={(loop) => setDeleteTarget({ id: loop.id, name: loop.name })}
                isStatusPending={statusMutation.isPending}
              />
            </>
          )}
        </div>

        {meta && (
          <ListPagination
            page={state.page}
            limit={state.limit}
            total={meta.total}
            onPageChange={goToPage}
            onLimitChange={updateLimit}
          />
        )}
      </div>

      {deleteTarget && (
        <DeleteLoopDialog
          loopName={deleteTarget.name}
          isOpen={true}
          onClose={() => setDeleteTarget(null)}
          onConfirm={handleDeleteConfirm}
          isDeleting={deleteMutation.isPending}
          error={deleteMutation.error}
        />
      )}
    </div>
  );
}
