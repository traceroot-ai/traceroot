"use client";

import { useMemo, useLayoutEffect } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { AlertTriangle } from "lucide-react";
import { useLayout } from "@/components/layout/app-layout";
import { DOMAIN_ICONS } from "@/components/icons/domain-icons";
import { Button } from "@/components/ui/button";
import { ListState, ListLoading } from "@/components/ui/list-state";
import { Table, TBody, Td, Th, THead, TR, TRHead } from "@/components/ui/table";
import { SearchFilterBar } from "@/components/search-filter-bar";
import { ListPagination } from "@/components/list-pagination";
import { ProjectBreadcrumb } from "@/features/projects/components";
import { Timestamp } from "@/features/offline-eval/components";
import { useUsers } from "@/features/traces/hooks";
import { useListPageState } from "@/lib/hooks/use-list-page-state";
import { useSession as useAuthSession } from "@/lib/auth-client";
import { formatCost, formatTokens, formatExactTokens, cn, buildUrlWithFilters } from "@/lib/utils";
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

  const { data, isPending: dataPending, error, refetch } = useUsers(projectId, userQueryOptions);
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
          retentionDays={retention.retentionDays}
          onUpgradeClick={retention.onUpgradeClick}
        />

        {/* Content */}
        <div className="flex-1 overflow-auto bg-background">
          {checking ? (
            <ListLoading label="Loading users..." />
          ) : error && !data ? (
            <ListState
              icon={<AlertTriangle className="h-8 w-8 text-destructive/50" />}
              title="Error loading users"
              description="Make sure the API server is running and you have API keys configured."
              action={
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 text-[12px]"
                  onClick={() => refetch()}
                >
                  Try again
                </Button>
              }
            />
          ) : users.length === 0 ? (
            <ListState
              icon={<DOMAIN_ICONS.user className="h-8 w-8 text-muted-foreground/40" />}
              title="No users found"
              description="Users will appear here when traces include user_id."
            />
          ) : (
            <div className="flex h-full flex-col">
              <div className="flex-1 overflow-auto">
                <Table>
                  <THead>
                    <TRHead>
                      <Th>User ID</Th>
                      <Th className="w-[100px]">Traces</Th>
                      <Th className="w-[110px]">Tokens</Th>
                      <Th className="w-[100px]">Cost</Th>
                      <Th className="w-[160px]">Last Activity</Th>
                    </TRHead>
                  </THead>
                  <TBody>
                    {users.map((user: UserListItem) => (
                      <TR
                        key={user.user_id}
                        interactive
                        onClick={() => handleUserClick(user.user_id)}
                      >
                        <Td className="max-w-[300px] truncate text-foreground" title={user.user_id}>
                          {user.user_id}
                        </Td>
                        <Td className="text-muted-foreground">{user.trace_count}</Td>
                        <Td className="text-muted-foreground">
                          {(user.total_input_tokens ?? 0) + (user.total_output_tokens ?? 0) > 0 ? (
                            <span
                              title={`${formatExactTokens(user.total_input_tokens)} / ${formatExactTokens(user.total_output_tokens)}`}
                            >
                              {formatTokens(user.total_input_tokens ?? 0)} /{" "}
                              {formatTokens(user.total_output_tokens ?? 0)}
                            </span>
                          ) : (
                            "-"
                          )}
                        </Td>
                        <Td className="text-muted-foreground">{formatCost(user.total_cost)}</Td>
                        <Td className="whitespace-nowrap text-muted-foreground">
                          <Timestamp iso={user.last_trace_time} />
                        </Td>
                      </TR>
                    ))}
                  </TBody>
                </Table>
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
      />
    </div>
  );
}
