"use client";

import { PageBackHeader } from "@/features/dashboards/components/PageBackHeader";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import { useRetention } from "@/lib/hooks/use-retention";
import { PricingDialog } from "@/ee/features/billing/PricingDialog";
import { PlanType } from "@traceroot/core";
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

  // ── retention — presets beyond the plan's window are locked (same as lists) ──
  const retention = useRetention(projectId);

  // ── time range — the same URL-synced filter AND default the trace list uses ──
  const { dateFilter, customStartDate, customEndDate, setDateFilter, setCustomRange, timestamps } =
    useUrlDateFilter(undefined, undefined, retention.retentionDays);
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
        <PageBackHeader
          backHref={`/projects/${projectId}/dashboard?list=1`}
          backLabel="Dashboards"
          title={dashboard?.name ?? "Dashboard"}
          actions={
            <>
              {dashboard && (
                <Button size="sm" onClick={openCreate}>
                  New widget
                </Button>
              )}
              <DateFilterSelect
                className="h-7"
                dateFilter={dateFilter}
                customStartDate={customStartDate}
                customEndDate={customEndDate}
                onDateFilterChange={setDateFilter}
                onCustomRangeChange={setCustomRange}
                retentionDays={retention.retentionDays}
                onUpgradeClick={retention.onUpgradeClick}
              />
            </>
          }
        />

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
                New widget
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

      <PricingDialog
        open={retention.showPricing}
        onOpenChange={retention.closePricing}
        workspaceId={retention.workspaceId}
        currentPlan={(retention.billingPlan as PlanType) || PlanType.FREE}
      />
    </div>
  );
}
