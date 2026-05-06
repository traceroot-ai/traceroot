"use client";

import { useMemo, useLayoutEffect, useState } from "react";
import Link from "next/link";
import { useParams, useSearchParams } from "next/navigation";
import { useLayout } from "@/components/layout/app-layout";
import { Workflow, Users, Layers } from "lucide-react";
import { SearchFilterBar } from "@/components/search-filter-bar";
import { ListPagination } from "@/components/list-pagination";
import { ProjectBreadcrumb } from "@/features/projects/components";
import { SessionDetailPanel } from "@/features/traces/components/SessionDetailPanel";
import { useSessions } from "@/features/traces/hooks";
import { useListPageState } from "@/lib/hooks/use-list-page-state";
import { formatDate, formatCost, formatTokens, cn, buildUrlWithFilters } from "@/lib/utils";
import type { SessionListItem, SessionQueryOptions } from "@/types/api";

const tabs = [
  { id: "traces", label: "Traces", icon: Workflow, href: "traces" },
  { id: "users", label: "Users", icon: Users, href: "users" },
  { id: "sessions", label: "Sessions", icon: Layers, href: "sessions" },
];

function getTotalCost(session: SessionListItem): number | null {
  return session.total_cost ?? null;
}

export default function SessionsPage() {
  const params = useParams();
  const searchParams = useSearchParams();
  const projectId = params.projectId as string;
  const { aiPanelOpen, setAiPanelOpen, setHideAiButton } = useLayout();
  const sessionIdFromUrl = searchParams.get("sessionId");
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(sessionIdFromUrl);

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

  useLayoutEffect(() => {
    setHideAiButton(false);
  }, [setHideAiButton]);

  const { data, isLoading, error } = useSessions(projectId, sessionQueryOptions);

  const sessions = data?.data || [];
  const total = data?.meta?.total ?? 0;

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

        {/* Filters bar */}
        <SearchFilterBar
          searchValue={state.keyword}
          onSearchChange={updateKeyword}
          searchPlaceholder="Search..."
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
          ) : error && !data ? (
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
                        Session ID
                      </th>
                      <th className="w-[140px] border-r border-border/50 px-3 py-1.5 text-left text-[12px] font-medium text-muted-foreground">
                        User ID
                      </th>
                      <th className="w-[110px] border-r border-border/50 px-3 py-1.5 text-left text-[12px] font-medium text-muted-foreground">
                        Tokens
                      </th>
                      <th className="w-[100px] border-r border-border/50 px-3 py-1.5 text-left text-[12px] font-medium text-muted-foreground">
                        Cost
                      </th>
                      <th className="w-[70px] px-3 py-1.5 text-left text-[12px] font-medium text-muted-foreground">
                        Traces
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {sessions.map((session: SessionListItem) => (
                      <tr
                        key={session.session_id}
                        onClick={() => {
                          setSelectedSessionId(session.session_id);
                          if (aiPanelOpen) setAiPanelOpen(false);
                        }}
                        className={cn(
                          "cursor-pointer border-b border-border/50 transition-colors last:border-0",
                          selectedSessionId === session.session_id
                            ? "bg-muted"
                            : "hover:bg-muted/50",
                        )}
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
                          {(session.total_input_tokens ?? 0) + (session.total_output_tokens ?? 0) >
                          0 ? (
                            <span
                              title={`${(session.total_input_tokens ?? 0).toLocaleString()} / ${(session.total_output_tokens ?? 0).toLocaleString()}`}
                            >
                              {formatTokens(session.total_input_tokens ?? 0)} /{" "}
                              {formatTokens(session.total_output_tokens ?? 0)}
                            </span>
                          ) : (
                            "-"
                          )}
                        </td>
                        <td className="border-r border-border/50 px-3 py-1.5 text-[12px] text-muted-foreground">
                          {formatCost(getTotalCost(session))}
                        </td>
                        <td className="px-3 py-1.5 text-[12px] text-muted-foreground">
                          {session.trace_count}
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
              />
            </div>
          )}
        </div>
      </div>

      {/* Detail panel - overlays right side, slides in from right (like traces) */}
      {selectedSessionId && (
        <div className="animate-slide-in-right fixed bottom-0 right-0 top-0 z-50 w-[70%] border-l border-border bg-background shadow-xl">
          <SessionDetailPanel
            projectId={projectId}
            sessionId={selectedSessionId}
            onClose={() => setSelectedSessionId(null)}
            onNavigate={(direction) => {
              const currentIndex = sessions.findIndex(
                (s: SessionListItem) => s.session_id === selectedSessionId,
              );
              if (direction === "up" && currentIndex > 0) {
                setSelectedSessionId(sessions[currentIndex - 1].session_id);
              } else if (direction === "down" && currentIndex < sessions.length - 1) {
                setSelectedSessionId(sessions[currentIndex + 1].session_id);
              }
            }}
            canNavigateUp={
              sessions.findIndex((s: SessionListItem) => s.session_id === selectedSessionId) > 0
            }
            canNavigateDown={
              sessions.findIndex((s: SessionListItem) => s.session_id === selectedSessionId) <
              sessions.length - 1
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
