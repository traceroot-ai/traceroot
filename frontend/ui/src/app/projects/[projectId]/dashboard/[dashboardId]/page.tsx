"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { ProjectBreadcrumb } from "@/features/projects/components";
import {
  useDashboards,
  useDashboard,
  useDashboardMutations,
} from "@/features/dashboards/hooks/use-dashboards";
import { DashboardGrid } from "@/features/dashboards/components/DashboardGrid";
import { CreateDashboardDialog } from "@/features/dashboards/components/CreateDashboardDialog";
import type { TimeRange, Widget } from "@/features/dashboards/types";
import { DateFilterSelect } from "@/components/date-filter-select";
import { useUrlDateFilter } from "@/lib/hooks/use-url-date-filter";
import { Button } from "@/components/ui/button";
import { DeleteIconButton } from "@/components/ui/delete-button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

// useLayoutEffect on the client, useEffect during SSR: layout effects never
// run on the server, and React warns when a server render encounters one.
const useIsomorphicLayoutEffect = typeof window !== "undefined" ? useLayoutEffect : useEffect;

// Tab strip scroll position per project, module-scoped: the page remounts on
// every dashboard switch, so component state can't carry the position across
// clicks. In-memory only — a hard reload falls back to scrolling the active
// tab into view.
const tabStripScroll = new Map<string, number>();

export default function DashboardDetailPage() {
  const params = useParams();
  const router = useRouter();
  const queryClient = useQueryClient();
  const projectId = params.projectId as string;
  const dashboardId = params.dashboardId as string;

  // ── remote data ──────────────────────────────────────────────────────────────
  const { data: dashboards } = useDashboards(projectId);
  const { data: dashboard, error: dashboardError } = useDashboard(projectId, dashboardId);

  const { updateLayout, createWidget, removeWidget, removeDashboard } = useDashboardMutations(
    projectId,
    dashboardId,
  );

  // ── time range — the same URL-synced filter AND default the trace list uses ──
  const { dateFilter, customStartDate, customEndDate, setDateFilter, setCustomRange, timestamps } =
    useUrlDateFilter();
  const range: TimeRange = useMemo(
    () => ({
      // Widgets need concrete bounds. startAfter is only absent for a custom
      // filter arriving via URL without its dates — fall back to the shared
      // 24h default; endBefore is absent for now-anchored presets, whose end
      // is "now" frozen at selection.
      start: timestamps.startAfter
        ? new Date(timestamps.startAfter)
        : new Date(Date.now() - 86_400_000),
      end: timestamps.endBefore ? new Date(timestamps.endBefore) : new Date(),
    }),
    [timestamps.startAfter, timestamps.endBefore],
  );

  // ── grid width via ResizeObserver ────────────────────────────────────────────
  const [width, setWidth] = useState(1200);
  const bodyRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) setWidth(entry.contentRect.width);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // ── keep the scrollable tab strip where the user left it ────────────────────
  const tabStripRef = useRef<HTMLDivElement>(null);
  // The route is keyed by the dashboardId segment, so clicking a tab remounts
  // this page and a fresh strip would snap back to the far left. Restore the
  // remembered position pre-paint (layout effect) so the switch is seamless;
  // re-run when the list arrives, since an empty strip can't hold a scroll.
  useIsomorphicLayoutEffect(() => {
    const el = tabStripRef.current;
    const saved = tabStripScroll.get(projectId);
    if (el && saved !== undefined) el.scrollLeft = saved;
  }, [projectId, dashboards?.length]);
  useEffect(() => {
    // Then make sure the active tab is visible: after a hard reload (nothing
    // remembered) a deep tab would sit out of view. "nearest" is a no-op when
    // the restored position already shows it. Optional call: jsdom (and any
    // environment without layout) doesn't implement scrollIntoView.
    tabStripRef.current
      ?.querySelector('[aria-current="page"]')
      ?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
    // Length, not the array: re-scroll when the list first arrives or grows,
    // without snapping the strip on unrelated list refetches mid-browse.
  }, [dashboardId, dashboards?.length]);

  // ── widget builder navigation ────────────────────────────────────────────────
  const openCreate = () =>
    router.push(`/projects/${projectId}/dashboard/${dashboardId}/widgets/new`);

  const openEdit = (w: Widget) =>
    router.push(`/projects/${projectId}/dashboard/${dashboardId}/widgets/${w.id}/edit`);

  // ── deleted / missing dashboard redirect ─────────────────────────────────────
  // fetchNextApi doesn't carry the HTTP status, so gone-ness is detected from
  // the API's error message. The exact match keeps "Project not found" (a
  // deleted project) and auth failures from redirecting; only a genuinely
  // missing dashboard leaves the page. Everything else keeps the user here —
  // the detail query's 30s poll retries, with a failure notice while empty.
  const dashboardGone =
    dashboardError instanceof Error &&
    (dashboardError.message === "Dashboard not found" ||
      /API error: 404/i.test(dashboardError.message));
  useEffect(() => {
    if (dashboardGone) {
      // Invalidate the list so a stale cache can't bounce the user back here.
      void queryClient.invalidateQueries({ queryKey: ["dashboards", projectId] });
      router.replace(`/projects/${projectId}/dashboard`);
    }
  }, [dashboardGone, projectId, queryClient, router]);

  // useDashboard resolves to undefined while loading and surfaces failures via
  // its error field; the redirect above handles gone dashboards, so the render
  // below only needs the loading and failure branches.

  // ── new dashboard ────────────────────────────────────────────────────────────
  const [createDashboardOpen, setCreateDashboardOpen] = useState(false);

  // ── delete dashboard ─────────────────────────────────────────────────────────
  const [deleteOpen, setDeleteOpen] = useState(false);
  const handleDeleteDashboard = () => {
    removeDashboard.mutate(dashboardId, {
      onSuccess: () => {
        setDeleteOpen(false);
        // The index route resolves to the default dashboard.
        router.replace(`/projects/${projectId}/dashboard`);
      },
    });
  };

  // ── layout change ────────────────────────────────────────────────────────────
  const handleLayoutChange = useCallback(
    (layout: Parameters<typeof updateLayout.mutate>[0]) => {
      updateLayout.mutate(layout);
    },
    [updateLayout],
  );

  // ── duplicate widget ─────────────────────────────────────────────────────────
  const handleDuplicate = useCallback(
    (w: Widget) => {
      createWidget.mutate({
        title: `${w.title} (copy)`,
        type: w.type,
        spec: w.spec,
        displayConfig: w.displayConfig,
      });
    },
    [createWidget],
  );

  // ── delete widget ────────────────────────────────────────────────────────────
  const handleDelete = useCallback(
    (w: Widget) => {
      removeWidget.mutate(w.id);
    },
    [removeWidget],
  );

  // ── render ───────────────────────────────────────────────────────────────────
  const widgets = dashboard?.widgets ?? [];
  const layout = dashboard?.layout ?? [];

  return (
    <div className="relative flex h-full text-[13px]">
      <ProjectBreadcrumb projectId={projectId} />

      <CreateDashboardDialog
        projectId={projectId}
        open={createDashboardOpen}
        onOpenChange={setCreateDashboardOpen}
      />

      <Dialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete Dashboard</DialogTitle>
            <DialogDescription>
              Permanently delete “{dashboard?.name}” and all of its widgets? This cannot be undone.
            </DialogDescription>
          </DialogHeader>
          {removeDashboard.isError && (
            <p className="text-sm text-destructive">{removeDashboard.error.message}</p>
          )}
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setDeleteOpen(false)}
              disabled={removeDashboard.isPending}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={handleDeleteDashboard}
              disabled={removeDashboard.isPending}
            >
              {removeDashboard.isPending ? "Deleting..." : "Delete"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <div className="flex flex-1 flex-col overflow-hidden">
        {/* Page header */}
        <div className="flex items-center justify-between border-b border-border px-4 py-2">
          {/* Left: title + dashboard tabs. min-w-0 lets the tab strip shrink
              and scroll instead of growing without bound — however many
              dashboards exist, the ＋ new button and the right-side controls
              stay on screen. */}
          <div className="flex min-w-0 flex-1 items-center gap-3">
            <h1 className="shrink-0 text-[13px] font-medium">Dashboard</h1>
            <div
              ref={tabStripRef}
              onScroll={(e) => tabStripScroll.set(projectId, e.currentTarget.scrollLeft)}
              className="flex min-w-0 items-center gap-0.5 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
            >
              {dashboards?.map((d) => (
                <Link
                  key={d.id}
                  href={`/projects/${projectId}/dashboard/${d.id}`}
                  aria-current={d.id === dashboardId ? "page" : undefined}
                  className={cn(
                    "flex shrink-0 items-center gap-1 rounded px-2 py-0.5 text-[12px] transition-colors",
                    d.id === dashboardId
                      ? "border-b-2 border-foreground font-medium text-foreground"
                      : "text-muted-foreground hover:bg-muted hover:text-foreground",
                  )}
                >
                  {d.isDefault && <span className="text-[10px]">⌂</span>}
                  <span className="max-w-[10rem] truncate" title={d.name}>
                    {d.name}
                  </span>
                </Link>
              ))}
            </div>
            <button
              type="button"
              onClick={() => setCreateDashboardOpen(true)}
              className="shrink-0 rounded px-2 py-0.5 text-[12px] text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              ＋ new
            </button>
          </div>

          {/* Right: time range, create widget */}
          <div className="flex shrink-0 items-center gap-2">
            <DateFilterSelect
              dateFilter={dateFilter}
              customStartDate={customStartDate}
              customEndDate={customEndDate}
              onDateFilterChange={setDateFilter}
              onCustomRangeChange={setCustomRange}
            />

            {/* Held back until the detail loads so edit controls don't act
                on a dashboard the app doesn't know yet. */}
            {dashboard && (
              <>
                <Button size="sm" className="h-7 text-[12px]" onClick={openCreate}>
                  ＋ Create widget
                </Button>
                <DeleteIconButton
                  aria-label="Delete dashboard"
                  onClick={() => setDeleteOpen(true)}
                />
              </>
            )}
          </div>
        </div>

        {/* Body */}
        <div ref={bodyRef} className="flex-1 overflow-auto bg-background">
          {dashboardError && !dashboardGone && !dashboard ? (
            // Only when there's nothing to render: a failed background poll
            // keeps the cached dashboard, and the stale grid beats a notice.
            <div className="flex h-64 items-center justify-center text-[13px] text-red-600">
              Failed to load the dashboard — retrying automatically
            </div>
          ) : !dashboard ? (
            <div className="flex h-64 items-center justify-center text-[13px] text-muted-foreground">
              Loading…
            </div>
          ) : widgets.length === 0 ? (
            <div className="flex h-64 flex-col items-center justify-center gap-3">
              <p className="text-[13px] text-muted-foreground">No widgets yet.</p>
              <Button size="sm" className="text-[12px]" onClick={openCreate}>
                ＋ Create widget
              </Button>
            </div>
          ) : (
            <DashboardGrid
              projectId={projectId}
              widgets={widgets}
              layout={layout}
              range={range}
              width={width}
              onLayoutChange={handleLayoutChange}
              onEdit={openEdit}
              onDuplicate={handleDuplicate}
              onDelete={handleDelete}
            />
          )}
        </div>
      </div>
    </div>
  );
}
