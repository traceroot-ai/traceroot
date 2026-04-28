"use client";

import { useState, useEffect, useLayoutEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useParams, useSearchParams, useRouter } from "next/navigation";
import { useLayout } from "@/components/layout/app-layout";
import { ChevronLeft, ChevronRight, ChevronDown, Workflow, Users, Layers, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { SearchFilterBar } from "@/components/search-filter-bar";
import { ProjectBreadcrumb } from "@/features/projects/components";
import {
  formatDuration,
  formatDate,
  formatCost,
  formatTokens,
  cn,
  buildUrlWithFilters,
} from "@/lib/utils";
import type { TraceListItem } from "@/types/api";
import { useTraces, useListPageState } from "@/features/traces/hooks";
import { TraceViewerPanel, GettingStarted } from "@/features/traces/components";
import { formatContentPreview } from "@/features/traces/utils";

// Tab definitions
const tabs = [
  { id: "traces", label: "Traces", icon: Workflow, href: "traces" },
  { id: "users", label: "Users", icon: Users, href: "users" },
  { id: "sessions", label: "Sessions", icon: Layers, href: "sessions" },
];

export default function TracesPage() {
  const params = useParams();
  const searchParams = useSearchParams();
  const router = useRouter();
  const projectId = params.projectId as string;
  const queryClient = useQueryClient();
  const { aiPanelOpen, setAiPanelOpen, setHideAiButton } = useLayout();
  const userId = searchParams.get("user_id");
  const traceIdFromUrl = searchParams.get("traceId");

  // Use URL-synced state management hook (shares date filter with other pages)
  const {
    state,
    updateDateFilter,
    updateCustomRange,
    updateKeyword,
    updateLimit,
    goToPage,
    queryOptions,
  } = useListPageState();

  // UI state for popovers
  const [itemsPerPageOpen, setItemsPerPageOpen] = useState(false);
  const [selectedTraceId, setSelectedTraceId] = useState<string | null>(traceIdFromUrl);
  const [autoRefresh, setAutoRefresh] = useState(false);

  // Fetch traces with combined query options + user filter from URL
  const { data, isLoading, error } = useTraces(
    projectId,
    {
      ...queryOptions,
      user_id: userId || undefined,
    },
    { refetchInterval: autoRefresh ? 5000 : false },
  );

  // Check if project has EVER sent traces (no date filter) — controls onboarding visibility.
  // staleTime: Infinity because once a project has traces it always will (immutable fact).
  // refetchInterval polls every 3s while onboarding is shown so the page auto-transitions
  // when the first trace arrives, without requiring a manual refresh.
  const { data: anyTracesData, isLoading: hasEverTracedLoading } = useTraces(
    projectId,
    { limit: 1 },
    {
      staleTime: Infinity,
      refetchInterval: (query: unknown) => {
        const hasTraces =
          ((query as { state?: { data?: { data?: unknown[] } } })?.state?.data?.data?.length ?? 0) >
          0;
        return hasTraces ? false : 3000;
      },
    },
  );
  const hasEverTraced = (anyTracesData?.data?.length ?? 0) > 0;
  useEffect(() => {
    if (hasEverTraced) queryClient.invalidateQueries({ queryKey: ["traces", projectId] });
  }, [hasEverTraced, projectId, queryClient]);

  const traces = data?.data || [];
  const meta = data?.meta || { page: 0, limit: 50, total: 0 };
  const totalPages = Math.ceil(meta.total / meta.limit);
  const showGettingStarted = !hasEverTracedLoading && !hasEverTraced;

  // Hide AI button during loading AND when GettingStarted is shown
  const shouldHideAiButton = hasEverTracedLoading || showGettingStarted;

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
      <div className="flex flex-1 flex-col">
        {/* Tab navigation — hidden during onboarding or while checking */}
        {!hasEverTracedLoading && !showGettingStarted && (
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
        {!hasEverTracedLoading && !showGettingStarted && (
          <SearchFilterBar
            searchValue={state.keyword}
            onSearchChange={updateKeyword}
            searchPlaceholder="Search..."
            dateFilter={state.dateFilter}
            customStartDate={state.customStartDate}
            customEndDate={state.customEndDate}
            onDateFilterChange={updateDateFilter}
            onCustomRangeChange={updateCustomRange}
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
                <Users className="h-3 w-3 text-muted-foreground" />
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
          {isLoading || hasEverTracedLoading ? (
            <div className="flex h-64 items-center justify-center">
              <p className="text-[13px] text-muted-foreground">Loading traces...</p>
            </div>
          ) : error && !data ? (
            <div className="flex h-64 flex-col items-center justify-center gap-3">
              <p className="text-[13px] text-destructive">Error loading traces</p>
              <p className="text-[12px] text-muted-foreground">
                Make sure the API server is running and you have API keys configured.
              </p>
            </div>
          ) : showGettingStarted ? (
            <GettingStarted projectId={projectId} />
          ) : traces.length === 0 ? (
            <div className="flex h-64 flex-col items-center justify-center gap-3">
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
                        Status
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
                          if (aiPanelOpen) setAiPanelOpen(false);
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
                        <td className="min-w-[280px] max-w-[400px] border-r border-border/50 px-3 py-1.5 font-mono text-[11px] text-muted-foreground">
                          <span title={trace.trace_id}>{trace.trace_id}</span>
                        </td>
                        <td className="border-r border-border/50 px-3 py-1.5">
                          {trace.status === "error" ? (
                            <span className="rounded bg-red-100 px-1.5 py-0.5 text-[10px] font-medium text-red-700 dark:bg-red-950 dark:text-red-400">
                              ERROR
                            </span>
                          ) : (
                            <span className="text-[10px] text-muted-foreground">OK</span>
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
                        <td className="border-r border-border/50 px-3 py-1.5 text-[12px] text-muted-foreground">
                          {(trace.total_input_tokens ?? 0) + (trace.total_output_tokens ?? 0) >
                          0 ? (
                            <span
                              title={`${(trace.total_input_tokens ?? 0).toLocaleString()} / ${(trace.total_output_tokens ?? 0).toLocaleString()}`}
                            >
                              {formatTokens(trace.total_input_tokens ?? 0)} /{" "}
                              {formatTokens(trace.total_output_tokens ?? 0)}
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

              {/* Pagination */}
              <div className="flex items-center justify-end gap-6 border-t border-border bg-background px-4 py-2.5">
                <div className="flex items-center gap-2">
                  <span className="text-[12px] text-muted-foreground">Items per page</span>
                  <Popover open={itemsPerPageOpen} onOpenChange={setItemsPerPageOpen}>
                    <PopoverTrigger asChild>
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-7 min-w-[60px] justify-between px-2 text-[12px]"
                      >
                        <span>{state.limit}</span>
                        <ChevronDown className="ml-1 h-3 w-3 text-muted-foreground" />
                      </Button>
                    </PopoverTrigger>
                    <PopoverContent side="top" align="start" className="w-[80px] p-1">
                      {[50, 100, 200].map((value) => (
                        <button
                          key={value}
                          className={cn(
                            "w-full rounded-md px-2.5 py-1.5 text-left text-[12px] transition-colors",
                            state.limit === value ? "bg-muted" : "hover:bg-muted/50",
                          )}
                          onClick={() => {
                            updateLimit(value);
                            setItemsPerPageOpen(false);
                          }}
                        >
                          {value}
                        </button>
                      ))}
                    </PopoverContent>
                  </Popover>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-[12px] text-muted-foreground">Page</span>
                  <input
                    type="number"
                    min={1}
                    max={Math.max(1, totalPages)}
                    value={state.page + 1}
                    onChange={(e) => {
                      const val = parseInt(e.target.value, 10);
                      if (!isNaN(val) && val >= 1 && val <= totalPages) {
                        goToPage(val - 1);
                      }
                    }}
                    className="h-7 w-12 rounded border border-border bg-background px-2 py-1 text-center text-[12px] [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
                  />
                  <span className="text-[12px] text-muted-foreground">
                    of {Math.max(1, totalPages)}
                  </span>
                </div>
                <div className="flex items-center gap-0.5">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => goToPage(0)}
                    disabled={state.page === 0}
                    className="h-7 w-7 p-0"
                  >
                    <ChevronLeft className="h-3.5 w-3.5" />
                    <ChevronLeft className="-ml-2 h-3.5 w-3.5" />
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => goToPage(Math.max(0, state.page - 1))}
                    disabled={state.page === 0}
                    className="h-7 w-7 p-0"
                  >
                    <ChevronLeft className="h-3.5 w-3.5" />
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => goToPage(state.page + 1)}
                    disabled={state.page >= totalPages - 1}
                    className="h-7 w-7 p-0"
                  >
                    <ChevronRight className="h-3.5 w-3.5" />
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => goToPage(totalPages - 1)}
                    disabled={state.page >= totalPages - 1}
                    className="h-7 w-7 p-0"
                  >
                    <ChevronRight className="h-3.5 w-3.5" />
                    <ChevronRight className="-ml-2 h-3.5 w-3.5" />
                  </Button>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Detail panel - overlays header, takes 70% width, slides in from right */}
      {selectedTraceId && (
        <div className="animate-slide-in-right fixed bottom-0 right-0 top-0 z-50 w-[70%] border-l border-border bg-background shadow-xl">
          <TraceViewerPanel
            projectId={projectId}
            traceId={selectedTraceId}
            onClose={() => setSelectedTraceId(null)}
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
            canNavigateUp={
              traces.findIndex((t: TraceListItem) => t.trace_id === selectedTraceId) > 0
            }
            canNavigateDown={
              traces.findIndex((t: TraceListItem) => t.trace_id === selectedTraceId) <
              traces.length - 1
            }
            dateFilter={state.dateFilter}
            customStartDate={state.customStartDate}
            customEndDate={state.customEndDate}
          />
        </div>
      )}
    </div>
  );
}
