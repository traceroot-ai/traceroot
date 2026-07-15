"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { ProjectBreadcrumb } from "@/features/projects/components";
import {
  isDashboardGone,
  useDashboard,
  useDashboardMutations,
} from "@/features/dashboards/hooks/use-dashboards";
import { DashboardGrid } from "@/features/dashboards/components/DashboardGrid";
import type { TimeRange, Widget } from "@/features/dashboards/types";
import { DateFilterSelect } from "@/components/date-filter-select";
import { useUrlDateFilter } from "@/lib/hooks/use-url-date-filter";
import { Button } from "@/components/ui/button";

export default function DashboardDetailPage() {
  const params = useParams();
  const router = useRouter();
  const queryClient = useQueryClient();
  const projectId = params.projectId as string;
  const dashboardId = params.dashboardId as string;

  // ── remote data ──────────────────────────────────────────────────────────────
  const { data: dashboard, error: dashboardError } = useDashboard(projectId, dashboardId);

  const { updateLayout, removeWidget } = useDashboardMutations(projectId, dashboardId);

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

  // ── widget builder navigation ────────────────────────────────────────────────
  const openCreate = () =>
    router.push(`/projects/${projectId}/dashboard/${dashboardId}/widgets/new`);

  const openEdit = (w: Widget) =>
    router.push(`/projects/${projectId}/dashboard/${dashboardId}/widgets/${w.id}/edit`);

  // ── deleted / missing dashboard redirect ─────────────────────────────────────
  // Any permanent failure leaves the page: the dashboard or its project was
  // deleted (404), or access was revoked (403) — the 30s poll can never
  // recover from those, so retrying in place would strand the user. Transient
  // failures keep the user here with a failure notice while the poll retries.
  const dashboardGone = isDashboardGone(dashboardError);
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

  // ── layout change ────────────────────────────────────────────────────────────
  const handleLayoutChange = useCallback(
    (layout: Parameters<typeof updateLayout.mutate>[0]) => {
      updateLayout.mutate(layout);
    },
    [updateLayout],
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

      <div className="flex flex-1 flex-col overflow-hidden">
        {/* Page header */}
        <div className="flex h-[45px] shrink-0 items-center justify-between border-b border-border px-4">
          {/* Left: breadcrumb back to the list + the dashboard's identity
              (the tabs are gone; the list page is the way to switch).
              "Dashboards" renders exactly like the list page's heading. */}
          <div className="flex min-w-0 items-center gap-2">
            <Link
              // ?list=1 pins the index on the list: without it a project with
              // a single dashboard would auto-open right back here.
              href={`/projects/${projectId}/dashboard?list=1`}
              className="shrink-0 text-[13px] font-medium hover:underline"
            >
              Dashboards
            </Link>
            <span className="shrink-0 text-muted-foreground">/</span>
            <h1 className="min-w-0 text-[13px] font-medium">
              <span className="block max-w-[16rem] truncate" title={dashboard?.name}>
                {dashboard?.name ?? "Dashboard"}
              </span>
            </h1>
          </div>

          {/* Right: create widget, then the time range. Deleting a dashboard
              lives only in the list page's row actions. */}
          <div className="flex items-center gap-2">
            {/* Held back until the detail loads so it can't act on a
                dashboard the app doesn't know yet. */}
            {dashboard && (
              <Button size="sm" className="h-7 text-[12px]" onClick={openCreate}>
                ＋ Create widget
              </Button>
            )}
            <DateFilterSelect
              dateFilter={dateFilter}
              customStartDate={customStartDate}
              customEndDate={customEndDate}
              onDateFilterChange={setDateFilter}
              onCustomRangeChange={setCustomRange}
            />
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
              onDelete={handleDelete}
            />
          )}
        </div>
      </div>
    </div>
  );
}
