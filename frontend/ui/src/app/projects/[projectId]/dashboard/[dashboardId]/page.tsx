"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import { cn } from "@/lib/utils";

export default function DashboardDetailPage() {
  const params = useParams();
  const router = useRouter();
  const queryClient = useQueryClient();
  const projectId = params.projectId as string;
  const dashboardId = params.dashboardId as string;

  // ── remote data ──────────────────────────────────────────────────────────────
  const { data: dashboards } = useDashboards(projectId);
  const { data: dashboard, error: dashboardError } = useDashboard(projectId, dashboardId);

  const { updateLayout, createWidget, removeWidget } = useDashboardMutations(
    projectId,
    dashboardId,
  );

  // ── time range — the same URL-synced filter the trace list uses ─────────────
  const { dateFilter, customStartDate, customEndDate, setDateFilter, setCustomRange, timestamps } =
    useUrlDateFilter(undefined, "7d");
  const range: TimeRange = useMemo(
    () => ({
      // Widgets need concrete bounds. startAfter is only absent for a custom
      // filter arriving via URL without its dates — fall back to the same 7d
      // default the hook was given; endBefore is absent for now-anchored
      // presets, whose end is "now" frozen at selection.
      start: timestamps.startAfter
        ? new Date(timestamps.startAfter)
        : new Date(Date.now() - 7 * 86_400_000),
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

  // ── widget builder navigation ────────────────────────────────────────────────
  const openCreate = () =>
    router.push(`/projects/${projectId}/dashboard/${dashboardId}/widgets/new`);

  const openEdit = (w: Widget) =>
    router.push(`/projects/${projectId}/dashboard/${dashboardId}/widgets/${w.id}/edit`);

  // ── deleted / missing dashboard redirect ─────────────────────────────────────
  useEffect(() => {
    if (dashboardError) {
      // Invalidate the list so a stale cache can't bounce the user back here.
      void queryClient.invalidateQueries({ queryKey: ["dashboards", projectId] });
      router.replace(`/projects/${projectId}/dashboard`);
    }
  }, [dashboardError, projectId, queryClient, router]);

  // useDashboard resolves to undefined while loading and throws on 404/error,
  // so dashboardError above handles the redirect. No additional null check needed.

  // ── new dashboard ────────────────────────────────────────────────────────────
  const [createDashboardOpen, setCreateDashboardOpen] = useState(false);

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

      <div className="flex flex-1 flex-col overflow-hidden">
        {/* Page header */}
        <div className="flex items-center justify-between border-b border-border px-4 py-2">
          {/* Left: title + dashboard tabs */}
          <div className="flex items-center gap-3">
            <h1 className="text-[13px] font-medium">Dashboard</h1>
            <div className="flex items-center gap-0.5">
              {dashboards?.map((d) => (
                <Link
                  key={d.id}
                  href={`/projects/${projectId}/dashboard/${d.id}`}
                  aria-current={d.id === dashboardId ? "page" : undefined}
                  className={cn(
                    "flex items-center gap-1 rounded px-2 py-0.5 text-[12px] transition-colors",
                    d.id === dashboardId
                      ? "border-b-2 border-foreground font-medium text-foreground"
                      : "text-muted-foreground hover:bg-muted hover:text-foreground",
                  )}
                >
                  {d.isDefault && <span className="text-[10px]">⌂</span>}
                  {d.name}
                </Link>
              ))}
              <button
                type="button"
                onClick={() => setCreateDashboardOpen(true)}
                className="rounded px-2 py-0.5 text-[12px] text-muted-foreground hover:bg-muted hover:text-foreground"
              >
                ＋ new
              </button>
            </div>
          </div>

          {/* Right: time range, create widget */}
          <div className="flex items-center gap-2">
            <DateFilterSelect
              dateFilter={dateFilter}
              customStartDate={customStartDate}
              customEndDate={customEndDate}
              onDateFilterChange={setDateFilter}
              onCustomRangeChange={setCustomRange}
            />

            <Button size="sm" className="h-7 text-[12px]" onClick={openCreate}>
              ＋ Create widget
            </Button>
          </div>
        </div>

        {/* Body */}
        <div ref={bodyRef} className="flex-1 overflow-auto bg-background">
          {!dashboard ? (
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
