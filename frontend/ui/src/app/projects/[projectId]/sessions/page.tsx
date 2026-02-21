"use client";

import { useState, useMemo } from "react";
import Link from "next/link";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { Workflow, Users, Layers, ChevronLeft, ChevronRight, ChevronDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { SearchFilterBar } from "@/components/search-filter-bar";
import { ProjectBreadcrumb } from "@/features/projects/components";
import { useSessions, useListPageState } from "@/features/traces/hooks";
import { formatDate, formatDuration, cn } from "@/lib/utils";
import type { SessionListItem, SessionQueryOptions } from "@/types/api";

const tabs = [
  { id: "traces", label: "Traces", icon: Workflow, href: "traces" },
  { id: "users", label: "Users", icon: Users, href: "users" },
  { id: "sessions", label: "Sessions", icon: Layers, href: "sessions" },
];

function formatTokens(count: number | null): string {
  if (count === null || count === undefined) return "-";
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  if (count >= 1_000) return `${(count / 1_000).toFixed(1)}k`;
  return String(count);
}

/** Truncate text for table cell preview */
function truncate(text: string | null, maxLen: number = 80): string {
  if (!text) return "-";
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen) + "...";
}

export default function SessionsPage() {
  const params = useParams();
  const router = useRouter();
  const searchParams = useSearchParams();
  const projectId = params.projectId as string;
  const [itemsPerPageOpen, setItemsPerPageOpen] = useState(false);

  const {
    state,
    updateDateFilter,
    updateCustomRange,
    updateKeyword,
    updateLimit,
    goToPage,
    queryOptions,
  } = useListPageState();

  const sessionQueryOptions = useMemo<SessionQueryOptions>(
    () => ({
      page: queryOptions.page,
      limit: queryOptions.limit,
      search_query: queryOptions.search_query,
      start_after: queryOptions.start_after,
      end_before: queryOptions.end_before,
    }),
    [queryOptions],
  );

  const { data, isLoading, error } = useSessions(projectId, sessionQueryOptions);

  const sessions = data?.data || [];
  const meta = data?.meta || { page: 0, limit: 50, total: 0 };
  const totalPages = Math.ceil(meta.total / meta.limit);

  const buildUrlWithFilters = (path: string) => {
    const urlParams = new URLSearchParams();

    const pageIndex = searchParams.get("page_index");
    const pageLimit = searchParams.get("page_limit");
    if (pageIndex) urlParams.set("page_index", pageIndex);
    if (pageLimit) urlParams.set("page_limit", pageLimit);

    const dateFilter = searchParams.get("date_filter");
    const start = searchParams.get("start");
    const end = searchParams.get("end");
    if (dateFilter) urlParams.set("date_filter", dateFilter);
    if (start) urlParams.set("start", start);
    if (end) urlParams.set("end", end);

    const queryString = urlParams.toString();
    return queryString ? `${path}?${queryString}` : path;
  };

  const handleSessionClick = (sessionId: string) => {
    router.push(`/projects/${projectId}/sessions/${encodeURIComponent(sessionId)}`);
  };

  return (
    <div className="relative flex h-full text-[13px]">
      <ProjectBreadcrumb projectId={projectId} />

      <div className="flex flex-1 flex-col">
        {/* Tab navigation */}
        <div className="border-b border-border bg-background">
          <div className="flex">
            {tabs.map((tab) => {
              const Icon = tab.icon;
              const isActive = tab.id === "sessions";
              return (
                <Link
                  key={tab.id}
                  href={buildUrlWithFilters(`/projects/${projectId}/${tab.href}`)}
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

        {/* Filters bar */}
        <SearchFilterBar
          searchValue={state.keyword}
          onSearchChange={updateKeyword}
          searchPlaceholder="Search by session ID..."
          dateFilter={state.dateFilter}
          customStartDate={state.customStartDate}
          customEndDate={state.customEndDate}
          onDateFilterChange={updateDateFilter}
          onCustomRangeChange={updateCustomRange}
        />

        {/* Content */}
        <div className="flex-1 overflow-auto bg-background">
          {isLoading ? (
            <div className="flex h-64 items-center justify-center">
              <p className="text-[13px] text-muted-foreground">Loading sessions...</p>
            </div>
          ) : error ? (
            <div className="flex h-64 flex-col items-center justify-center gap-3">
              <p className="text-[13px] text-destructive">Error loading sessions</p>
              <p className="text-[12px] text-muted-foreground">
                Make sure the API server is running.
              </p>
            </div>
          ) : sessions.length === 0 ? (
            <div className="flex h-64 flex-col items-center justify-center gap-3">
              <Layers className="h-10 w-10 text-muted-foreground" />
              <p className="text-[13px] text-muted-foreground">No sessions found</p>
              <p className="text-[12px] text-muted-foreground">
                Sessions will appear here when traces include session_id.
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
                        ID
                      </th>
                      <th className="w-[140px] border-r border-border/50 px-3 py-1.5 text-left text-[12px] font-medium text-muted-foreground">
                        User IDs
                      </th>
                      <th className="w-[70px] border-r border-border/50 px-3 py-1.5 text-left text-[12px] font-medium text-muted-foreground">
                        Traces
                      </th>
                      <th className="border-r border-border/50 px-3 py-1.5 text-left text-[12px] font-medium text-muted-foreground">
                        Input
                      </th>
                      <th className="border-r border-border/50 px-3 py-1.5 text-left text-[12px] font-medium text-muted-foreground">
                        Output
                      </th>
                      <th className="w-[90px] border-r border-border/50 px-3 py-1.5 text-left text-[12px] font-medium text-muted-foreground">
                        Latency
                      </th>
                      <th className="w-[80px] px-3 py-1.5 text-left text-[12px] font-medium text-muted-foreground">
                        Tokens
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {sessions.map((session: SessionListItem) => {
                      const totalTokens =
                        session.total_input_tokens !== null || session.total_output_tokens !== null
                          ? (session.total_input_tokens ?? 0) + (session.total_output_tokens ?? 0)
                          : null;
                      return (
                        <tr
                          key={session.session_id}
                          onClick={() => handleSessionClick(session.session_id)}
                          className="cursor-pointer border-b border-border/50 transition-colors last:border-0 hover:bg-muted/50"
                        >
                          <td className="whitespace-nowrap border-r border-border/50 px-3 py-1.5 text-[12px] text-muted-foreground">
                            {formatDate(session.first_trace_time)}
                          </td>
                          <td className="border-r border-border/50 px-3 py-1.5 text-[12px] font-medium text-foreground">
                            {session.session_id}
                          </td>
                          <td className="border-r border-border/50 px-3 py-1.5 text-[12px] text-muted-foreground">
                            {session.user_ids.length > 0 ? session.user_ids.join(", ") : "-"}
                          </td>
                          <td className="border-r border-border/50 px-3 py-1.5 text-[12px] text-muted-foreground">
                            {session.trace_count}
                          </td>
                          <td className="max-w-[180px] border-r border-border/50 px-3 py-1.5">
                            <span
                              className="block truncate font-mono text-[11px] text-muted-foreground"
                              title={session.input ?? undefined}
                            >
                              {truncate(session.input)}
                            </span>
                          </td>
                          <td className="max-w-[180px] border-r border-border/50 px-3 py-1.5">
                            <span
                              className="block truncate font-mono text-[11px] text-muted-foreground"
                              title={session.output ?? undefined}
                            >
                              {truncate(session.output)}
                            </span>
                          </td>
                          <td className="border-r border-border/50 px-3 py-1.5 text-[12px] text-muted-foreground">
                            {formatDuration(session.duration_ms)}
                          </td>
                          <td className="whitespace-nowrap px-3 py-1.5 text-[12px] text-foreground">
                            {formatTokens(totalTokens)}
                          </td>
                        </tr>
                      );
                    })}
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
    </div>
  );
}
