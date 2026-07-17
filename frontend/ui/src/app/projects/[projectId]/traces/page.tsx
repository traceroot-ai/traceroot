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
import {
  formatDuration,
  formatDate,
  formatCost,
  formatTokenFlow,
  formatExactTokens,
  cn,
  buildUrlWithFilters,
} from "@/lib/utils";
import type { TraceListItem } from "@/types/api";
import { useTraces, usePrefetchTraces, useTracesExist } from "@/features/traces/hooks";
import { useRetention } from "@/lib/hooks/use-retention";
import { PricingDialog } from "@/ee/features/billing/PricingDialog";
import { PlanType } from "@traceroot/core";
import { useListPageState } from "@/lib/hooks/use-list-page-state";
import { useLocalStorage } from "@/lib/hooks/use-local-storage";
import { TraceViewerPanel, GettingStarted } from "@/features/traces/components";
import { LoadingState } from "@/components/ui/loading-state";
import type { TraceSelection } from "@/features/traces";
import { Button } from "@/components/ui/button";
import {
  SaveTestCaseDrawer,
  TraceEvaluationChip,
  SpanDatasetChip,
} from "@/features/evaluations/components/trace-integration";
import { useTraceTestCases } from "@/features/evaluations/hooks";
import { formatContentPreview } from "@/features/traces/utils";
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
  // Warm the span→dataset chip data as soon as a trace is selected, so the
  // "Dataset:" chip is ready before the user opens a span (no per-span latency).
  useTraceTestCases(projectId, selectedTraceId ?? "");
  // Save-as-test-case (offline eval): which span the drawer targets (undefined = root).
  const [saveOpen, setSaveOpen] = useState(false);
  const [saveSpanId, setSaveSpanId] = useState<string | undefined>(undefined);
  // Close the drawer (and drop its target span) whenever the selected trace changes —
  // including closing the viewer entirely. Without this, the drawer reopens on the
  // NEXT trace still targeting a span from the previous one (which won't resolve
  // there), stuck with no way out but closing and reopening it.
  useEffect(() => {
    setSaveOpen(false);
    setSaveSpanId(undefined);
  }, [selectedTraceId]);
  // Persisted per-project so a live view survives reloads, navigation, and re-login.
  // Default false: a project the user never toggled behaves exactly as before.
  const [autoRefresh, setAutoRefresh] = useLocalStorage(
    `traceroot:traces:live:v1:${projectId}`,
    false,
  );
  // Fetch traces with combined query options + user filter from URL.
  // Evaluation traces are excluded from this default list.
  const { data, isLoading, error } = useTraces(
    projectId,
    {
      ...queryOptions,
      user_id: userId || undefined,
    },
    { refetchInterval: autoRefresh ? 5000 : false },
  );

  const prefetchTraces = usePrefetchTraces(projectId);

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
            <div className="flex">
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
                <table className="w-full">
                  <thead className="sticky top-0 bg-background">
                    <tr className="border-b border-border bg-muted/50">
                      <th className="w-[140px] border-r border-border/50 px-3 py-1.5 text-left text-[12px] font-medium text-muted-foreground">
                        Timestamp
                      </th>
                      <th className="border-r border-border/50 px-3 py-1.5 text-left text-[12px] font-medium text-muted-foreground">
                        Name
                      </th>
                      <th className="min-w-[280px] max-w-[400px] border-r border-border/50 px-3 py-1.5 text-left text-[12px] font-medium text-muted-foreground">
                        Trace ID
                      </th>
                      <th className="w-[60px] border-r border-border/50 px-3 py-1.5 text-left text-[12px] font-medium text-muted-foreground">
                        Errors
                      </th>
                      <th className="w-[60px] border-r border-border/50 px-3 py-1.5 text-left text-[12px] font-medium text-muted-foreground">
                        Spans
                      </th>
                      <th className="border-r border-border/50 px-3 py-1.5 text-left text-[12px] font-medium text-muted-foreground">
                        Input
                      </th>
                      <th className="border-r border-border/50 px-3 py-1.5 text-left text-[12px] font-medium text-muted-foreground">
                        Output
                      </th>
                      <th className="w-[100px] border-r border-border/50 px-3 py-1.5 text-left text-[12px] font-medium text-muted-foreground">
                        Tokens
                      </th>
                      <th className="w-[80px] border-r border-border/50 px-3 py-1.5 text-left text-[12px] font-medium text-muted-foreground">
                        Cost
                      </th>
                      <th className="px-3 py-1.5 text-left text-[12px] font-medium text-muted-foreground">
                        Latency
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {traces.map((trace: TraceListItem) => (
                      <tr
                        key={trace.trace_id}
                        onClick={() => {
                          setSelectedTraceId(trace.trace_id);
                        }}
                        className={cn(
                          "cursor-pointer border-b border-border/50 transition-colors last:border-0",
                          selectedTraceId === trace.trace_id ? "bg-muted" : "hover:bg-muted/50",
                        )}
                      >
                        <td className="whitespace-nowrap border-r border-border/50 px-3 py-1.5 text-[12px] text-muted-foreground">
                          {formatDate(trace.trace_start_time)}
                        </td>
                        <td className="border-r border-border/50 px-3 py-1.5 text-[12px] text-foreground">
                          {trace.name}
                        </td>
                        <td className="min-w-[280px] max-w-[400px] whitespace-nowrap border-r border-border/50 px-3 py-1.5 font-mono text-[11px] text-muted-foreground">
                          <span className="block truncate" title={trace.trace_id}>
                            {trace.trace_id}
                          </span>
                        </td>
                        <td className="border-r border-border/50 px-3 py-1.5 text-center">
                          {trace.error_count > 0 ? (
                            <span className="inline-flex min-w-5 justify-center rounded bg-red-100 px-1.5 py-0.5 text-[10px] font-medium text-red-700 dark:bg-red-950 dark:text-red-400">
                              {trace.error_count}
                            </span>
                          ) : (
                            <span className="text-[12px] text-muted-foreground">0</span>
                          )}
                        </td>
                        <td className="border-r border-border/50 px-3 py-1.5 text-center text-[12px] text-muted-foreground">
                          {trace.span_count}
                        </td>
                        <td className="max-w-[180px] border-r border-border/50 px-3 py-1.5">
                          <span className="block truncate font-mono text-[11px] text-muted-foreground">
                            {formatContentPreview(trace.input)}
                          </span>
                        </td>
                        <td className="max-w-[180px] border-r border-border/50 px-3 py-1.5">
                          <span className="block truncate font-mono text-[11px] text-muted-foreground">
                            {formatContentPreview(trace.output)}
                          </span>
                        </td>
                        <td className="whitespace-nowrap border-r border-border/50 px-3 py-1.5 text-[12px] text-muted-foreground">
                          {(trace.total_input_tokens ?? 0) + (trace.total_output_tokens ?? 0) >
                          0 ? (
                            <span
                              title={`${formatExactTokens(trace.total_input_tokens)} → ${formatExactTokens(trace.total_output_tokens)} (${formatExactTokens((trace.total_input_tokens ?? 0) + (trace.total_output_tokens ?? 0))})`}
                            >
                              {formatTokenFlow(trace.total_input_tokens, trace.total_output_tokens)}
                            </span>
                          ) : (
                            "-"
                          )}
                        </td>
                        <td className="border-r border-border/50 px-3 py-1.5 text-[12px] text-foreground">
                          {trace.total_cost && trace.total_cost > 0
                            ? formatCost(trace.total_cost)
                            : "-"}
                        </td>
                        <td className="whitespace-nowrap px-3 py-1.5 text-[12px] text-foreground">
                          {formatDuration(trace.duration_ms)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
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
          // Offline eval: save any span (or the trace root) as a dataset test case.
          spanHeaderAction={(selection: TraceSelection) => (
            <Button
              variant="outline"
              size="sm"
              className="h-7 shrink-0 text-[12px]"
              onClick={() => {
                setSaveSpanId(selection.type === "span" ? selection.span.span_id : undefined);
                setSaveOpen(true);
              }}
            >
              Save as test case
            </Button>
          )}
          // Offline eval: while the "Save as test case" drawer is open, clicking a
          // different span in the tree retargets the drawer to that span.
          onSelectionChange={(selection: TraceSelection) => {
            if (saveOpen) {
              setSaveSpanId(selection.type === "span" ? selection.span.span_id : undefined);
            }
          }}
          // Offline eval: a trace-level chip when this trace came from a run, and
          // a per-span "Dataset:" chip marking a span already saved as a test case.
          spanExtraTags={(selection: TraceSelection) =>
            selection.type === "trace" ? (
              <TraceEvaluationChip projectId={projectId} traceId={selectedTraceId} />
            ) : (
              <SpanDatasetChip
                projectId={projectId}
                traceId={selectedTraceId}
                spanId={selection.span.span_id}
              />
            )
          }
          // Customer surface, so state the scope explicitly rather than inheriting it:
          // the reader already defaults to customer traffic, so this is defense in depth,
          // and it also pins the trace-detail cache key this panel shares with the live
          // SSE writer. Self-traces are reached from the detector runs surface, which
          // asks for source="detector" explicitly.
          source="user"
        />
      )}

      <SaveTestCaseDrawer
        projectId={projectId}
        traceId={selectedTraceId}
        spanId={saveSpanId}
        open={saveOpen}
        onOpenChange={setSaveOpen}
      />

      <PricingDialog
        open={retention.showPricing}
        onOpenChange={retention.closePricing}
        workspaceId={retention.workspaceId}
        currentPlan={(retention.billingPlan as PlanType) || PlanType.FREE}
      />
    </div>
  );
}
