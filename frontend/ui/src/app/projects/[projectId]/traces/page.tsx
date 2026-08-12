"use client";

import { useState, useEffect, useLayoutEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useParams, useSearchParams, useRouter } from "next/navigation";
import { useLayout } from "@/components/layout/app-layout";
import { X, Inbox, AlertTriangle } from "lucide-react";
import { DOMAIN_ICONS } from "@/components/icons/domain-icons";
import { SearchFilterBar } from "@/components/search-filter-bar";
import { TraceSearchFilterInput } from "@/features/filters/trace-search-filter-input";
import { ListPagination } from "@/components/list-pagination";
import { ProjectBreadcrumb } from "@/features/projects/components";
import { cn, buildUrlWithFilters } from "@/lib/utils";
import type { TraceListItem } from "@/types/api";
import { useTraces, usePrefetchTraces, useTracesExist } from "@/features/traces/hooks";
import { useRetention } from "@/lib/hooks/use-retention";
import { PricingDialog } from "@/ee/features/billing/PricingDialog";
import { PlanType } from "@traceroot/core";
import { useListPageState } from "@/lib/hooks/use-list-page-state";
import { useLocalStorage } from "@/lib/hooks/use-local-storage";
import { TraceViewerPanel, GettingStarted } from "@/features/traces/components";
import { LoadingState } from "@/components/ui/loading-state";
import { TraceListTable } from "@/features/traces/components/TraceListTable";
import { ColumnPicker } from "@/features/traces/components/ColumnPicker";
// Imported from the hook's own module, not the feature barrel: the page tests replace that
// barrel wholesale with a factory mock, and a barrel import here would go missing under it.
import { useTraceColumns } from "@/features/traces/hooks/use-trace-columns";
import { useSession as useAuthSession } from "@/lib/auth-client";

// Tab definitions
const tabs = [
  { id: "traces", label: "Traces", icon: DOMAIN_ICONS.trace, href: "traces" },
  { id: "users", label: "Users", icon: DOMAIN_ICONS.user, href: "users" },
  { id: "sessions", label: "Sessions", icon: DOMAIN_ICONS.session, href: "sessions" },
];

export default function TracesPage() {
  const params = useParams();
  const searchParams = useSearchParams();
  const router = useRouter();
  const projectId = params.projectId as string;
  const queryClient = useQueryClient();
  const { setHideAiButton } = useLayout();
  const { isPending: authPending } = useAuthSession();
  const userId = searchParams.get("user_id");
  const traceIdFromUrl = searchParams.get("traceId");
  // Set when a trace is opened in a new tab via the panel's "open in new tab"
  // button, so the panel mounts already expanded to full width. Held as state
  // (not a derived value) so it only seeds the first trace opened from the URL:
  // once the user closes the panel, opening another trace defaults back to the
  // unexpanded width rather than re-expanding from the lingering URL param.
  const [startFullscreen, setStartFullscreen] = useState(searchParams.get("fullscreen") === "1");

  const retention = useRetention(projectId);

  // Use URL-synced state management hook (shares date filter with other pages)
  const {
    state,
    updateDateFilter,
    updateCustomRange,
    updateFilters,
    updateLimit,
    goToPage,
    queryOptions,
  } = useListPageState({ retentionDays: retention.retentionDays });

  const [selectedTraceId, setSelectedTraceId] = useState<string | null>(traceIdFromUrl);
  // Persisted per-project so a live view survives reloads, navigation, and re-login.
  // Default false: a project the user never toggled behaves exactly as before.
  const [autoRefresh, setAutoRefresh] = useLocalStorage(
    `traceroot:traces:live:v1:${projectId}`,
    false,
  );

  // Fetch traces with combined query options + user filter from URL
  const { data, isLoading, error } = useTraces(
    projectId,
    {
      ...queryOptions,
      user_id: userId || undefined,
    },
    { refetchInterval: autoRefresh ? 5000 : false },
  );

  const prefetchTraces = usePrefetchTraces(projectId);

  const { visibleColumns, toggleField, reset: resetColumns } = useTraceColumns(projectId);

  // Check if project has EVER sent traces — controls onboarding visibility.
  // Uses a dedicated endpoint that bypasses retention gating (returns a
  // boolean, not trace data) so projects with only retention-expired data
  // don't incorrectly show the onboarding screen.
  // staleTime: Infinity because once a project has traces it always will.
  // refetchInterval polls every 3s while onboarding is shown so the page
  // auto-transitions when the first trace arrives.
  const {
    data: existsData,
    isPending: hasEverTracedPending,
    error: existsError,
  } = useTracesExist(projectId, {
    refetchInterval: (query: unknown) => {
      const exists =
        (query as { state?: { data?: { exists?: boolean } } })?.state?.data?.exists ?? false;
      return exists ? false : 3000;
    },
  });
  const hasEverTraced = existsData?.exists ?? false;
  // Auth-gated React Query reports isLoading: false while disabled (TanStack v5),
  // so derive a single "still figuring it out" flag from auth + the probe's isPending.
  const checking = authPending || hasEverTracedPending;
  useEffect(() => {
    if (hasEverTraced) queryClient.invalidateQueries({ queryKey: ["traces", projectId] });
  }, [hasEverTraced, projectId, queryClient]);

  const traces = data?.data || [];
  const total = data?.meta?.total ?? 0;
  const showGettingStarted = !checking && !hasEverTraced && !existsError;

  // Hide AI button during loading AND when GettingStarted is shown
  const shouldHideAiButton = checking || showGettingStarted;

  useLayoutEffect(() => {
    setHideAiButton(shouldHideAiButton);
  }, [shouldHideAiButton, setHideAiButton]);

  const buildUrl = (path: string, extraParams?: Record<string, string>) =>
    buildUrlWithFilters(path, {
      dateFilter: state.dateFilter,
      customStartDate: state.customStartDate,
      customEndDate: state.customEndDate,
      extraParams,
    });

  return (
    <div className="relative flex h-full text-[13px]">
      <ProjectBreadcrumb projectId={projectId} />

      {/* Main content */}
      <div className="flex min-w-0 flex-1 flex-col">
        {/* Tab navigation — hidden during onboarding or while checking */}
        {!checking && !showGettingStarted && (
          <div className="border-b border-border bg-background">
            <div className="flex items-center">
              {tabs.map((tab) => {
                const Icon = tab.icon;
                const isActive = tab.id === "traces";
                return (
                  <Link
                    key={tab.id}
                    href={buildUrl(`/projects/${projectId}/${tab.href}`)}
                    className={cn(
                      "flex items-center gap-1.5 border-b-2 px-3 py-1.5 text-[13px] font-medium transition-colors",
                      isActive
                        ? "border-foreground bg-muted text-foreground"
                        : "border-transparent text-muted-foreground hover:bg-muted/50 hover:text-foreground",
                    )}
                  >
                    <Icon className="h-3.5 w-3.5" />
                    {tab.label}
                  </Link>
                );
              })}
            </div>
          </div>
        )}

        {/* Filters bar — hidden during onboarding or while checking */}
        {!checking && !showGettingStarted && (
          <SearchFilterBar
            searchInput={
              <TraceSearchFilterInput
                projectId={projectId}
                filters={state.filters}
                onFiltersChange={updateFilters}
                startAfter={queryOptions.start_after}
                endBefore={queryOptions.end_before}
              />
            }
            dateFilter={state.dateFilter}
            customStartDate={state.customStartDate}
            customEndDate={state.customEndDate}
            onDateFilterChange={updateDateFilter}
            onCustomRangeChange={updateCustomRange}
            retentionDays={retention.retentionDays}
            onUpgradeClick={retention.onUpgradeClick}
            beforeDateFilter={
              <ColumnPicker
                visibleColumns={visibleColumns}
                onToggleField={toggleField}
                onReset={resetColumns}
              />
            }
          >
            <button
              type="button"
              role="switch"
              aria-checked={autoRefresh}
              onClick={() => setAutoRefresh(!autoRefresh)}
              title={
                autoRefresh
                  ? "Live list refresh on (every 5s) — click to disable"
                  : "Enable live list refresh"
              }
              className="flex items-center gap-2 rounded-md border border-border px-2.5 py-1 text-[12px] text-foreground transition-colors hover:border-foreground/40 hover:bg-muted"
            >
              Live
              <span
                className={cn(
                  "relative inline-flex h-4 w-7 shrink-0 rounded-full border-2 border-transparent transition-colors duration-200",
                  autoRefresh ? "bg-foreground" : "bg-input",
                )}
              >
                <span
                  className={cn(
                    "block h-3 w-3 rounded-full bg-background shadow-sm transition-transform duration-200",
                    autoRefresh ? "translate-x-3" : "translate-x-0",
                  )}
                />
              </span>
            </button>
            {userId && (
              <div className="flex items-center gap-1.5 rounded-md border border-border bg-muted/50 py-1 pl-2.5 pr-1.5">
                <DOMAIN_ICONS.user className="h-3 w-3 text-muted-foreground" />
                <span className="text-[12px] text-muted-foreground">User:</span>
                <span className="text-[12px] font-medium text-foreground">{userId}</span>
                <button
                  type="button"
                  onClick={() => router.push(buildUrl(`/projects/${projectId}/traces`))}
                  className="ml-1 rounded p-0.5 transition-colors hover:bg-muted"
                >
                  <X className="h-3 w-3 text-muted-foreground" />
                </button>
              </div>
            )}
          </SearchFilterBar>
        )}

        {/* Content */}
        <div className="flex-1 overflow-auto bg-background">
          {isLoading || checking ? (
            <div className="flex h-64 items-center justify-center">
              <LoadingState label="Loading traces..." />
            </div>
          ) : error && !data ? (
            <div className="flex h-64 flex-col items-center justify-center gap-3 text-center">
              <AlertTriangle className="h-8 w-8 text-destructive/50" />
              <p className="text-[13px] text-destructive">Error loading traces</p>
              <p className="text-[12px] text-muted-foreground">
                Make sure the API server is running and you have API keys configured.
              </p>
            </div>
          ) : showGettingStarted ? (
            <GettingStarted projectId={projectId} />
          ) : traces.length === 0 ? (
            <div className="flex h-64 flex-col items-center justify-center gap-3 text-center">
              <Inbox className="h-8 w-8 text-muted-foreground/40" />
              <p className="text-[13px] text-muted-foreground">No traces found</p>
              <p className="text-[12px] text-muted-foreground">
                Try adjusting your filters or date range.
              </p>
            </div>
          ) : (
            <div className="flex h-full flex-col">
              <div className="flex-1 overflow-auto">
                <TraceListTable
                  traces={traces}
                  selectedTraceId={selectedTraceId}
                  onSelectTrace={setSelectedTraceId}
                  visibleColumns={visibleColumns}
                />
              </div>

              <ListPagination
                page={state.page}
                limit={state.limit}
                total={total}
                onPageChange={goToPage}
                onLimitChange={updateLimit}
                onPrefetchPage={
                  autoRefresh
                    ? undefined
                    : (p) =>
                        prefetchTraces({ ...queryOptions, user_id: userId || undefined, page: p })
                }
              />
            </div>
          )}
        </div>
      </div>

      {/* Detail panel — TraceViewerPanel renders its own fixed slide-in overlay */}
      {selectedTraceId && (
        <TraceViewerPanel
          projectId={projectId}
          traceId={selectedTraceId}
          onClose={() => {
            setSelectedTraceId(null);
            setStartFullscreen(false);
          }}
          onNavigate={(direction) => {
            const currentIndex = traces.findIndex(
              (t: TraceListItem) => t.trace_id === selectedTraceId,
            );
            if (direction === "up" && currentIndex > 0) {
              setSelectedTraceId(traces[currentIndex - 1].trace_id);
            } else if (direction === "down" && currentIndex < traces.length - 1) {
              setSelectedTraceId(traces[currentIndex + 1].trace_id);
            }
          }}
          canNavigateUp={traces.findIndex((t: TraceListItem) => t.trace_id === selectedTraceId) > 0}
          canNavigateDown={
            traces.findIndex((t: TraceListItem) => t.trace_id === selectedTraceId) <
            traces.length - 1
          }
          dateFilter={state.dateFilter}
          customStartDate={state.customStartDate}
          customEndDate={state.customEndDate}
          initialFullscreen={startFullscreen}
          // Customer surface, so state the scope explicitly rather than inheriting it:
          // the reader already defaults to customer traffic, so this is defense in depth,
          // and it also pins the trace-detail cache key this panel shares with the live
          // SSE writer. Self-traces are reached from the detector runs surface, which
          // asks for source="detector" explicitly.
          source="user"
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
