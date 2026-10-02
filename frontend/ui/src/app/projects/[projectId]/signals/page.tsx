"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useParams, useSearchParams } from "next/navigation";
import { PlanType } from "@traceroot/core";
import { DateFilterSelect } from "@/components/date-filter-select";
import { LoadingState } from "@/components/ui/loading-state";
import { SearchFilterBar } from "@/components/search-filter-bar";
import { useLayout } from "@/components/layout/app-layout";
import { PricingDialog } from "@/ee/features/billing/PricingDialog";
import { ListPagination } from "@/components/list-pagination";
import { ProjectBreadcrumb } from "@/features/projects/components";
import { TraceSearchFilterInput } from "@/features/filters/trace-search-filter-input";
import type { FilterFieldDef } from "@/features/filters/registry";
import type { Predicate } from "@/types/api";
import { TraceViewerPanel } from "@/features/traces/components/TraceViewerPanel";
import { useDetectorList } from "@/features/detectors/hooks/use-detectors";
import { useListPageState } from "@/lib/hooks/use-list-page-state";
import { useRetention } from "@/lib/hooks/use-retention";
import { SIGNAL_ID_PARAM, SIGNAL_STATUSES } from "@traceroot/core/signals";
import { useSignalSetup, useSignals } from "@/ee/features/signals/hooks";
import { SignalsEmptyState } from "@/ee/features/signals/components/signals-empty-state";
import { Button } from "@/components/ui/button";
import { SignalDetailPanel } from "@/ee/features/signals/components/signal-detail-panel";
import { STATUS_LABELS } from "@/ee/features/signals/components/signal-status-control";
import { serializeFiltersParam } from "@/features/filters/predicate";
import { buildUrlWithFilters, formatDate, cn } from "@/lib/utils";

/** The list opens on open signals; removing the chip sticks (see useUrlFilters). */
const SIGNALS_DEFAULT_FILTERS: Predicate[] = [{ field: "status", op: "in", value: ["open"] }];
/** The time window when none is picked or stored. It counts hits; it never hides a signal. */
const SIGNALS_DEFAULT_DATE_FILTER_ID = "7d";

/** The filter chips of this list; every value is typed or picked, none is looked up in traces. */
function signalFilterFields(detectorNames: string[]): FilterFieldDef[] {
  const field = (def: Omit<FilterFieldDef, "level" | "enum_values"> & { enum_values?: string[] }) =>
    ({ level: "SIGNAL", enum_values: [], ...def }) as FilterFieldDef;
  return [
    field({
      field: "status",
      label: "Status",
      type: "categorical",
      operators: ["in"],
      value_source: "static_enum",
      enum_values: [...SIGNAL_STATUSES],
    }),
    field({
      field: "detector",
      label: "Detector",
      type: "categorical",
      operators: ["in"],
      value_source: "static_enum",
      enum_values: detectorNames,
    }),
    field({
      field: "title",
      label: "Signal name",
      type: "text",
      operators: ["contains"],
      value_source: "free_text",
    }),
    field({
      field: "signal_id",
      label: "Signal ID",
      type: "text",
      operators: ["eq"],
      value_source: "free_text",
    }),
  ];
}

const TH =
  "border-r border-border/50 px-3 py-1.5 text-left text-[12px] font-medium text-muted-foreground";
const TD = "border-r border-border/50 px-3 py-1.5 text-[12px]";

export default function SignalsPage() {
  const params = useParams();
  const projectId = params.projectId as string;
  const searchParams = useSearchParams();
  const selectedSignalId = searchParams.get(SIGNAL_ID_PARAM);
  // The open signal lives in the URL too, so a link to it can be shared and
  // the back button returns to it from a trace.
  const setSelectedSignalId = (id: string | null) => {
    setOpenTrace(null);
    if (!id) setFullscreen(false);
    const url = new URL(window.location.href);
    if (id) url.searchParams.set(SIGNAL_ID_PARAM, id);
    else url.searchParams.delete(SIGNAL_ID_PARAM);
    window.history.replaceState(null, "", url);
  };

  const retention = useRetention(projectId);
  const {
    state,
    queryOptions,
    updateFilters,
    updateDateFilter,
    updateCustomRange,
    updateLimit,
    goToPage,
  } = useListPageState({
    defaultFilters: SIGNALS_DEFAULT_FILTERS,
    defaultDateFilterId: SIGNALS_DEFAULT_DATE_FILTER_ID,
    retentionDays: retention.retentionDays,
  });
  // The window counts each signal's affected traces, in the list and the panel.
  const range = { startAfter: queryOptions.start_after, endBefore: queryOptions.end_before };
  const rangePicker = (
    <DateFilterSelect
      dateFilter={state.dateFilter}
      customStartDate={state.customStartDate}
      customEndDate={state.customEndDate}
      onDateFilterChange={updateDateFilter}
      onCustomRangeChange={updateCustomRange}
      retentionDays={retention.retentionDays}
      onUpgradeClick={retention.onUpgradeClick}
    />
  );
  // The Tracing list narrowed to one signal's traces, in the same time range.
  const tracesHref = (signalId: string) =>
    buildUrlWithFilters(`/projects/${projectId}/traces`, {
      dateFilter: state.dateFilter,
      customStartDate: state.customStartDate,
      customEndDate: state.customEndDate,
      extraParams: {
        filters: serializeFiltersParam([{ field: "signal_id", op: "eq", value: signalId }])!,
      },
    });
  const { sidebarCollapsed } = useLayout();
  const [fullscreen, setFullscreen] = useState(false);
  // A trace opened from the signal panel, in a layer over it, and the list of
  // traces its up/down buttons step through.
  const [openTrace, setOpenTrace] = useState<{ traceId: string; traceIds: string[] } | null>(null);
  const traceIndex = openTrace ? openTrace.traceIds.indexOf(openTrace.traceId) : -1;
  useEffect(() => {
    setOpenTrace(null);
    if (!selectedSignalId) setFullscreen(false);
  }, [selectedSignalId]);

  const { data: detectorData } = useDetectorList(projectId, { limit: 200 });
  const fields = useMemo(
    () =>
      signalFilterFields(
        [...new Set((detectorData?.data ?? []).map((d) => d.name))].sort((a, b) =>
          a.localeCompare(b),
        ),
      ),
    [detectorData],
  );

  const { data, isLoading, error } = useSignals(projectId, {
    page: queryOptions.page,
    limit: queryOptions.limit,
    filters: queryOptions.filters,
    ...range,
  });
  const signals = data?.data ?? [];
  const meta = data?.meta;
  const selectedIndex = signals.findIndex((s) => s.id === selectedSignalId);
  // Nothing listed: ask whether the project has any signal at all, to tell
  // "set up a detector" from "nothing matches these filters".
  const listEmpty = !isLoading && !error && signals.length === 0;
  const setup = useSignalSetup(projectId, listEmpty);

  if (listEmpty && setup.data?.signalCount === 0) {
    return (
      <div className="relative flex h-full text-[13px]">
        <ProjectBreadcrumb projectId={projectId} />
        <div className="flex flex-1 flex-col overflow-hidden">
          <div className="flex items-center justify-between border-b border-border px-4 py-2">
            <h1 className="text-[13px] font-medium">Signals</h1>
          </div>
          <div className="flex-1 overflow-auto">
            <SignalsEmptyState projectId={projectId} setup={setup.data} />
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="relative flex h-full text-[13px]">
      <ProjectBreadcrumb projectId={projectId} />

      <div className="flex flex-1 flex-col overflow-hidden">
        <div className="flex items-center justify-between border-b border-border px-4 py-2">
          <h1 className="text-[13px] font-medium">Signals</h1>
        </div>

        <SearchFilterBar
          searchInput={
            <TraceSearchFilterInput
              projectId={projectId}
              filters={state.filters}
              onFiltersChange={updateFilters}
              fields={fields}
              placeholder="Filter signals…"
            />
          }
          beforeDateFilter={rangePicker}
        />

        <div className="flex-1 overflow-auto bg-background">
          {isLoading ? (
            <div className="flex h-64 items-center justify-center">
              <LoadingState label="Loading signals..." />
            </div>
          ) : error ? (
            <div className="flex h-64 flex-col items-center justify-center gap-3">
              <p className="text-[13px] text-destructive">Error loading signals</p>
            </div>
          ) : signals.length === 0 ? (
            setup.isPending ? (
              <div className="flex h-64 items-center justify-center">
                <LoadingState label="Loading signals..." />
              </div>
            ) : setup.error ? (
              <div className="flex h-64 flex-col items-center justify-center gap-3">
                <p className="text-[13px] text-muted-foreground">Unable to load signal setup.</p>
                <Button variant="outline" size="sm" onClick={() => void setup.refetch()}>
                  Try again
                </Button>
              </div>
            ) : (
              <div className="flex h-64 flex-col items-center justify-center gap-3 text-muted-foreground">
                <p>No signals match your filters.</p>
                {state.filters.length > 0 && (
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-7 text-[12px]"
                    onClick={() => updateFilters([])}
                  >
                    Clear filters
                  </Button>
                )}
              </div>
            )
          ) : (
            <table className="w-full">
              <thead className="sticky top-0 bg-background">
                <tr className="border-b border-border bg-muted/50">
                  <th className={cn(TH, "w-[150px]")}>Timestamp</th>
                  <th className={TH}>Signal ID</th>
                  <th className={TH}>Signal name</th>
                  <th className={TH}>Detector ID</th>
                  <th className={TH}>Detector name</th>
                  <th className={cn(TH, "w-[120px] text-right")}>Affected traces</th>
                  <th className="w-[90px] px-3 py-1.5 text-left text-[12px] font-medium text-muted-foreground">
                    Status
                  </th>
                </tr>
              </thead>
              <tbody>
                {signals.map((signal) => (
                  <tr
                    key={signal.id}
                    onClick={() => setSelectedSignalId(signal.id)}
                    className={cn(
                      "cursor-pointer border-b border-border/50 transition-colors last:border-0",
                      selectedSignalId === signal.id ? "bg-muted" : "hover:bg-muted/50",
                    )}
                  >
                    <td className={cn(TD, "whitespace-nowrap text-muted-foreground")}>
                      {formatDate(signal.createTime)}
                    </td>
                    <td className={cn(TD, "font-mono text-[11px] text-muted-foreground")}>
                      {signal.id}
                    </td>
                    <td className={cn(TD, "text-foreground")}>{signal.title}</td>
                    <td className={cn(TD, "font-mono text-[11px] text-muted-foreground")}>
                      <Link
                        href={`/projects/${projectId}/detectors/${signal.detectorId}`}
                        onClick={(e) => e.stopPropagation()}
                        className="hover:text-foreground hover:underline"
                        aria-label={`Open detector ${signal.detectorName ?? signal.detectorId}`}
                      >
                        {signal.detectorId}
                      </Link>
                    </td>
                    <td className={cn(TD, "text-foreground")}>{signal.detectorName ?? "—"}</td>
                    <td className={cn(TD, "text-right tabular-nums text-muted-foreground")}>
                      <Link
                        href={tracesHref(signal.id)}
                        onClick={(e) => e.stopPropagation()}
                        className="hover:text-foreground hover:underline"
                        aria-label={`View affected traces for ${signal.title}`}
                      >
                        {signal.rangeHitCount ?? signal.hitCount}
                      </Link>
                    </td>
                    <td className="px-3 py-1.5 text-[12px] text-foreground">
                      {STATUS_LABELS[signal.status]}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        {meta && (
          <ListPagination
            page={meta.page}
            limit={meta.limit}
            total={meta.total}
            onPageChange={goToPage}
            onLimitChange={updateLimit}
          />
        )}
      </div>

      {/* Detail panel: overlays the right side, like the trace and session panels.
          Full screen it starts below the header bar and right of the sidebar, as the trace panel does. */}
      {selectedSignalId && (
        <div
          className={cn(
            "animate-slide-in-right fixed bottom-0 right-0 z-50 border-l border-border bg-background shadow-xl transition-[width,top] duration-200",
            fullscreen
              ? sidebarCollapsed
                ? "top-14 w-[calc(100%-3.5rem)]"
                : "top-14 w-[calc(100%-12rem)]"
              : "top-0 w-[70%]",
          )}
        >
          <SignalDetailPanel
            projectId={projectId}
            signalId={selectedSignalId}
            onClose={() => setSelectedSignalId(null)}
            onNavigate={(direction) => {
              const next = direction === "up" ? selectedIndex - 1 : selectedIndex + 1;
              if (next >= 0 && next < signals.length) setSelectedSignalId(signals[next].id);
            }}
            canNavigateUp={selectedIndex > 0}
            canNavigateDown={selectedIndex >= 0 && selectedIndex < signals.length - 1}
            onOpenTrace={(traceId, traceIds) => setOpenTrace({ traceId, traceIds })}
            covered={!!openTrace}
            range={range}
            rangePicker={rangePicker}
            tracesHref={tracesHref(selectedSignalId)}
            fullscreen={fullscreen}
            onToggleFullscreen={() => setFullscreen((v) => !v)}
          />
        </div>
      )}

      {/* A trace opened from the signal: the trace viewer's own overlay, over the signal panel. */}
      {selectedSignalId && openTrace && (
        <TraceViewerPanel
          projectId={projectId}
          traceId={openTrace.traceId}
          onClose={() => setOpenTrace(null)}
          onNavigate={(direction) => {
            const next = openTrace.traceIds[direction === "up" ? traceIndex - 1 : traceIndex + 1];
            if (next) setOpenTrace({ ...openTrace, traceId: next });
          }}
          canNavigateUp={traceIndex > 0}
          canNavigateDown={traceIndex >= 0 && traceIndex < openTrace.traceIds.length - 1}
          // Narrower than the signal panel (70%), so the signal shows beneath.
          overlayWidthClassName="w-[60%]"
        />
      )}

      <PricingDialog
        open={retention.showPricing}
        onOpenChange={retention.closePricing}
        workspaceId={retention.workspaceId}
        currentPlan={(retention.billingPlan as PlanType) || PlanType.FREE}
      />
    </div>
  );
}
