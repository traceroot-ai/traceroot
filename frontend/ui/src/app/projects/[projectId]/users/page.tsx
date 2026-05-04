"use client";

import { useMemo, useLayoutEffect } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useLayout } from "@/components/layout/app-layout";
import { Workflow, Users, Layers } from "lucide-react";
import { SearchFilterBar } from "@/components/search-filter-bar";
import { ListPagination } from "@/components/list-pagination";
import { ProjectBreadcrumb } from "@/features/projects/components";
import { useUsers } from "@/features/traces/hooks";
import { useListPageState } from "@/lib/hooks/use-list-page-state";
import { formatDate, formatCost, formatTokens, cn, buildUrlWithFilters } from "@/lib/utils";
import type { UserListItem } from "@/lib/api/users";
import type { UserQueryOptions } from "@/lib/api/users";

const tabs = [
  { id: "traces", label: "Traces", icon: Workflow, href: "traces" },
  { id: "users", label: "Users", icon: Users, href: "users" },
  { id: "sessions", label: "Sessions", icon: Layers, href: "sessions" },
];

export default function UsersPage() {
  const params = useParams();
  const router = useRouter();
  const projectId = params.projectId as string;
  const { setHideAiButton } = useLayout();

  useLayoutEffect(() => {
    setHideAiButton(false);
  }, [setHideAiButton]);

  // Use URL-synced state management (shares date filter with other pages)
  const {
    state,
    updateDateFilter,
    updateCustomRange,
    updateKeyword,
    updateLimit,
    goToPage,
    queryOptions,
  } = useListPageState();

  // Build user query options from shared state
  const userQueryOptions = useMemo<UserQueryOptions>(
    () => ({
      page: queryOptions.page,
      limit: queryOptions.limit,
      search_query: queryOptions.search_query,
      start_after: queryOptions.start_after,
      end_before: queryOptions.end_before,
    }),
    [queryOptions],
  );

  const { data, isLoading, error } = useUsers(projectId, userQueryOptions);

  const users = data?.data || [];
  const total = data?.meta?.total ?? 0;

  const buildUrl = (path: string, extraParams?: Record<string, string>) =>
    buildUrlWithFilters(path, {
      dateFilter: state.dateFilter,
      customStartDate: state.customStartDate,
      customEndDate: state.customEndDate,
      extraParams,
    });

  const handleUserClick = (userId: string) => {
    router.push(buildUrl(`/projects/${projectId}/traces`, { user_id: userId }));
  };

  return (
    <div className="relative flex h-full text-[13px]">
      <ProjectBreadcrumb projectId={projectId} />

      {/* Main content */}
      <div className="flex flex-1 flex-col">
        {/* Tab navigation */}
        <div className="border-b border-border bg-background">
          <div className="flex">
            {tabs.map((tab) => {
              const Icon = tab.icon;
              const isActive = tab.id === "users";
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
              <p className="text-[13px] text-muted-foreground">Loading users...</p>
            </div>
          ) : error && !data ? (
            <div className="flex h-64 flex-col items-center justify-center gap-3">
              <p className="text-[13px] text-destructive">Error loading users</p>
              <p className="text-[12px] text-muted-foreground">
                Make sure the API server is running.
              </p>
            </div>
          ) : users.length === 0 ? (
            <div className="flex h-64 flex-col items-center justify-center gap-3">
              <Users className="h-10 w-10 text-muted-foreground" />
              <p className="text-[13px] text-muted-foreground">No users found</p>
              <p className="text-[12px] text-muted-foreground">
                Users will appear here when traces include user_id.
              </p>
            </div>
          ) : (
            <div className="flex h-full flex-col">
              <div className="flex-1 overflow-auto">
                <table className="w-full">
                  <thead className="sticky top-0 bg-background">
                    <tr className="border-b border-border bg-muted/50">
                      <th className="border-r border-border/50 px-3 py-1.5 text-left text-[12px] font-medium text-muted-foreground">
                        User ID
                      </th>
                      <th className="w-[100px] border-r border-border/50 px-3 py-1.5 text-left text-[12px] font-medium text-muted-foreground">
                        Traces
                      </th>
                      <th className="w-[110px] border-r border-border/50 px-3 py-1.5 text-left text-[12px] font-medium text-muted-foreground">
                        Tokens
                      </th>
                      <th className="w-[100px] border-r border-border/50 px-3 py-1.5 text-left text-[12px] font-medium text-muted-foreground">
                        Cost
                      </th>
                      <th className="w-[160px] px-3 py-1.5 text-left text-[12px] font-medium text-muted-foreground">
                        Last Activity
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {users.map((user: UserListItem) => (
                      <tr
                        key={user.user_id}
                        onClick={() => handleUserClick(user.user_id)}
                        className="cursor-pointer border-b border-border/50 transition-colors last:border-0 hover:bg-muted/50"
                      >
                        <td className="border-r border-border/50 px-3 py-2 text-[12px] text-foreground">
                          {user.user_id}
                        </td>
                        <td className="border-r border-border/50 px-3 py-2 text-[12px] text-muted-foreground">
                          {user.trace_count}
                        </td>
                        <td className="border-r border-border/50 px-3 py-2 text-[12px] text-muted-foreground">
                          {(user.total_input_tokens ?? 0) + (user.total_output_tokens ?? 0) > 0 ? (
                            <span
                              title={`${(user.total_input_tokens ?? 0).toLocaleString()} / ${(user.total_output_tokens ?? 0).toLocaleString()}`}
                            >
                              {formatTokens(user.total_input_tokens ?? 0)} /{" "}
                              {formatTokens(user.total_output_tokens ?? 0)}
                            </span>
                          ) : (
                            "-"
                          )}
                        </td>
                        <td className="border-r border-border/50 px-3 py-2 text-[12px] text-muted-foreground">
                          {formatCost(user.total_cost)}
                        </td>
                        <td className="px-3 py-2 text-[12px] text-muted-foreground">
                          {formatDate(user.last_trace_time)}
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
    </div>
  );
}
