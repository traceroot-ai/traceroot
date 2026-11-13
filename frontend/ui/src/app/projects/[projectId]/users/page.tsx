"use client";

import { useMemo, useLayoutEffect, useRef } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useLayout } from "@/components/layout/app-layout";
import { DOMAIN_ICONS } from "@/components/icons/domain-icons";
import { LoadingState } from "@/components/ui/loading-state";
import { SearchFilterBar } from "@/components/search-filter-bar";
import { ListPagination } from "@/components/list-pagination";
import { ProjectBreadcrumb } from "@/features/projects/components";
import { useUsers } from "@/features/traces/hooks";
import { useListPageState } from "@/lib/hooks/use-list-page-state";
import { useScrollToTopOnChange } from "@/lib/hooks/use-scroll-to-top-on-change";
import { useSession as useAuthSession } from "@/lib/auth-client";
import {
  formatDate,
  formatCost,
  formatTokenFlow,
  formatExactTokens,
  cn,
  buildUrlWithFilters,
} from "@/lib/utils";
import type { UserListItem } from "@/lib/api/users";
import type { UserQueryOptions } from "@/lib/api/users";
import { useRetention } from "@/lib/hooks/use-retention";
import { PricingDialog } from "@/ee/features/billing/PricingDialog";
import { PlanType } from "@traceroot/core";

const tabs = [
  { id: "traces", label: "Traces", icon: DOMAIN_ICONS.trace, href: "traces" },
  { id: "users", label: "Users", icon: DOMAIN_ICONS.user, href: "users" },
  { id: "sessions", label: "Sessions", icon: DOMAIN_ICONS.session, href: "sessions" },
];

export default function UsersPage() {
  const params = useParams();
  const router = useRouter();
  const projectId = params.projectId as string;
  const { setHideAiButton } = useLayout();
  const { isPending: authPending } = useAuthSession();

  useLayoutEffect(() => {
    setHideAiButton(false);
  }, [setHideAiButton]);

  const retention = useRetention(projectId);

  // Use URL-synced state management (shares date filter with other pages)
  const {
    state,
    updateDateFilter,
    updateCustomRange,
    updateKeyword,
    updateLimit,
    goToPage,
    queryOptions,
  } = useListPageState({ retentionDays: retention.retentionDays });

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

  // Every new page of rows, or a new search/time range, starts at the top of the list.
  const listRef = useRef<HTMLDivElement>(null);
  useScrollToTopOnChange(listRef, JSON.stringify(userQueryOptions));

  const { data, isPending: dataPending, error } = useUsers(projectId, userQueryOptions);
  // Auth-gated React Query reports isLoading: false while disabled (TanStack v5).
  // Use isPending OR'd with auth pending so the loading branch shows during the
  // auth-resolution window instead of falling through to the empty state.
  const checking = authPending || dataPending;

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
      <div className="flex min-w-0 flex-1 flex-col">
        {/* Tab navigation */}
        <div className="flex h-11 items-center border-b border-border bg-background">
          <div className="flex gap-1 px-4">
            {tabs.map((tab) => {
              const Icon = tab.icon;
              const isActive = tab.id === "users";
              return (
                <Link
                  key={tab.id}
                  href={buildUrl(`/projects/${projectId}/${tab.href}`)}
                  className={cn(
                    "flex items-center gap-1.5 rounded-[2px] px-2.5 py-1.5 text-[13px] font-medium transition-colors",
                    isActive
                      ? "bg-accent text-accent-foreground"
                      : "text-muted-foreground hover:bg-muted hover:text-foreground",
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
          retentionDays={retention.retentionDays}
          onUpgradeClick={retention.onUpgradeClick}
        />

        {/* Content */}
        <div className="flex-1 overflow-auto bg-background">
          {checking ? (
            <div className="flex h-64 items-center justify-center">
              <LoadingState label="Loading users..." />
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
              <DOMAIN_ICONS.user className="h-10 w-10 text-muted-foreground" />
              <p className="text-[13px] text-muted-foreground">No users found</p>
              <p className="text-[12px] text-muted-foreground">
                Users will appear here when traces include user_id.
              </p>
            </div>
          ) : (
            <div className="flex h-full flex-col">
              <div ref={listRef} className="flex-1 overflow-auto">
                <table className="data-table w-full tabular-nums [&_:is(th,td):nth-child(n+2):nth-child(-n+4)]:text-right">
                  <thead className="sticky top-0 bg-background">
                    <tr className="border-b border-border">
                      <th className="whitespace-nowrap border-r border-border px-3 py-1.5 text-left text-[12px] font-medium text-muted-foreground">
                        User ID
                      </th>
                      <th className="w-[100px] whitespace-nowrap border-r border-border px-3 py-1.5 text-left text-[12px] font-medium text-muted-foreground">
                        Traces
                      </th>
                      <th className="w-[110px] whitespace-nowrap border-r border-border px-3 py-1.5 text-left text-[12px] font-medium text-muted-foreground">
                        Tokens
                      </th>
                      <th className="w-[100px] whitespace-nowrap border-r border-border px-3 py-1.5 text-left text-[12px] font-medium text-muted-foreground">
                        Cost
                      </th>
                      <th className="w-[160px] whitespace-nowrap px-3 py-1.5 text-left text-[12px] font-medium text-muted-foreground">
                        Last Activity
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {users.map((user: UserListItem) => (
                      <tr
                        key={user.user_id}
                        onClick={() => handleUserClick(user.user_id)}
                        className="cursor-pointer border-b border-border transition-colors hover:bg-muted"
                      >
                        <td className="whitespace-nowrap border-r border-border px-3 py-2 text-[12px] text-foreground">
                          {user.user_id}
                        </td>
                        <td className="whitespace-nowrap border-r border-border px-3 py-2 text-[12px] text-muted-foreground">
                          {user.trace_count}
                        </td>
                        <td className="whitespace-nowrap border-r border-border px-3 py-2 text-[12px] text-muted-foreground">
                          {(user.total_input_tokens ?? 0) + (user.total_output_tokens ?? 0) > 0 ? (
                            <span
                              title={`${formatExactTokens(user.total_input_tokens)} / ${formatExactTokens(user.total_output_tokens)}`}
                            >
                              {formatTokenFlow(user.total_input_tokens, user.total_output_tokens)}
                            </span>
                          ) : (
                            "-"
                          )}
                        </td>
                        <td className="whitespace-nowrap border-r border-border px-3 py-2 text-[12px] text-muted-foreground">
                          {formatCost(user.total_cost)}
                        </td>
                        <td className="whitespace-nowrap px-3 py-2 text-[12px] text-muted-foreground">
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

      <PricingDialog
        open={retention.showPricing}
        onOpenChange={retention.closePricing}
        workspaceId={retention.workspaceId}
        currentPlan={(retention.billingPlan as PlanType) || PlanType.FREE}
        hasSubscription={retention.hasSubscription}
      />
    </div>
  );
}
