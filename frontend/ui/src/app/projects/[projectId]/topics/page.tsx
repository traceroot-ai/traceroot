"use client";

import { useMemo } from "react";
import { useParams } from "next/navigation";
import { RefreshCw } from "lucide-react";
import { TASK_GROUPS_LABEL } from "@traceroot/core/task-groups";
import { DateFilterSelect } from "@/components/date-filter-select";
import { LoadingState } from "@/components/ui/loading-state";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { ProjectBreadcrumb } from "@/features/projects/components";
import { serializeFiltersParam } from "@/features/filters/predicate";
import type { Predicate } from "@/types/api";
import { useListPageState } from "@/lib/hooks/use-list-page-state";
import { useRetention } from "@/lib/hooks/use-retention";
import { buildUrlWithFilters } from "@/lib/utils";
import {
  useRefreshTaskGroups,
  useTaskGroups,
  useUpdateTaskGroupSettings,
} from "@/ee/features/task-groups/hooks";
import { TopicsStatusPanel } from "@/ee/features/task-groups/components/topics-status-panel";
import { TopicsTable } from "@/ee/features/task-groups/components/topics-table";
import { TopicsTrendChart } from "@/ee/features/task-groups/components/topics-trend-chart";

/** No default filters: a stable array, since the list-page state depends on its identity. */
const NO_FILTERS: Predicate[] = [];
/** The time window when none is picked or stored. */
const DEFAULT_DATE_FILTER_ID = "7d";

function timeOfDay(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

export default function TopicsPage() {
  const params = useParams();
  const projectId = params.projectId as string;
  const retention = useRetention(projectId);
  const { state, queryOptions, updateDateFilter, updateCustomRange } = useListPageState({
    defaultFilters: NO_FILTERS,
    defaultDateFilterId: DEFAULT_DATE_FILTER_ID,
    retentionDays: retention.retentionDays,
  });
  const { data, isLoading, error, refetch } = useTaskGroups(projectId, {
    startAfter: queryOptions.start_after,
    endBefore: queryOptions.end_before,
  });
  const settings = useUpdateTaskGroupSettings(projectId);
  const refresh = useRefreshTaskGroups(projectId);

  const tracesHref = (groupId: string) =>
    buildUrlWithFilters(`/projects/${projectId}/traces`, {
      dateFilter: state.dateFilter,
      customStartDate: state.customStartDate,
      customEndDate: state.customEndDate,
      extraParams: {
        filters: serializeFiltersParam([{ field: "group_id", op: "eq", value: groupId }])!,
      },
    });

  const rows = useMemo(() => data?.groups ?? [], [data]);
  const enabled = data?.state.enabled ?? false;
  const refreshWaitsUntil = data?.refreshAvailableAt ?? null;
  const refreshBlocked =
    !enabled || refresh.isPending || (refreshWaitsUntil !== null && !refresh.isError);
  const refreshRefused = refresh.isError ? refresh.error.message : null;

  return (
    <div className="relative flex h-full text-[13px]">
      <ProjectBreadcrumb projectId={projectId} />
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex items-center justify-between gap-4 border-b border-border px-4 py-3">
          <div className="min-w-0">
            <h1 className="text-[15px] font-semibold text-foreground">{TASK_GROUPS_LABEL}</h1>
            <p className="text-muted-foreground">
              What your agents are asked to do, grouped automatically from a sample of traces.
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-3">
            {data && (
              <label className="flex items-center gap-2 text-[12px] text-muted-foreground">
                <span>{enabled ? "On" : "Off"}</span>
                <Switch
                  checked={enabled}
                  disabled={settings.isPending}
                  onCheckedChange={(checked) => settings.mutate({ enabled: checked })}
                />
                <span className="sr-only">{TASK_GROUPS_LABEL} for this project</span>
              </label>
            )}
            <Button
              variant="outline"
              size="sm"
              className="h-7 gap-1.5 text-[12px]"
              disabled={refreshBlocked}
              title={
                !enabled
                  ? `Turn ${TASK_GROUPS_LABEL} on first`
                  : refreshWaitsUntil
                    ? `Available again at ${timeOfDay(refreshWaitsUntil)}`
                    : "Fit the groups again now"
              }
              onClick={() => refresh.mutate()}
            >
              <RefreshCw className="h-3 w-3" />
              Refresh now
            </Button>
          </div>
        </div>

        {data && (
          <TopicsStatusPanel
            overview={data}
            canChange
            turningOn={settings.isPending}
            onTurnOn={() => settings.mutate({ enabled: true })}
          />
        )}
        {refreshRefused && (
          <p className="border-b border-border px-4 py-2 text-[12px] text-muted-foreground">
            {refreshRefused}
          </p>
        )}
        {settings.isError && (
          <p className="border-b border-border px-4 py-2 text-[12px] text-destructive">
            {settings.error.message}
          </p>
        )}

        <div className="flex items-center justify-end border-b border-border px-4 py-2">
          <DateFilterSelect
            dateFilter={state.dateFilter}
            customStartDate={state.customStartDate}
            customEndDate={state.customEndDate}
            onDateFilterChange={updateDateFilter}
            onCustomRangeChange={updateCustomRange}
            retentionDays={retention.retentionDays}
            onUpgradeClick={retention.onUpgradeClick}
          />
        </div>

        <div className="flex-1 overflow-auto bg-background">
          {isLoading ? (
            <div className="flex h-64 items-center justify-center">
              <LoadingState label={`Loading ${TASK_GROUPS_LABEL.toLowerCase()}...`} />
            </div>
          ) : error || !data ? (
            <div className="flex h-64 flex-col items-center justify-center gap-3">
              <p className="text-[13px] text-destructive">
                Could not load {TASK_GROUPS_LABEL.toLowerCase()}
              </p>
              <Button variant="outline" size="sm" onClick={() => void refetch()}>
                Try again
              </Button>
            </div>
          ) : rows.length === 0 ? (
            <div className="flex h-48 flex-col items-center justify-center gap-1 text-center text-muted-foreground">
              {data.fittedAt === null ? (
                <p>No {TASK_GROUPS_LABEL.toLowerCase()} yet.</p>
              ) : (
                <p>No sampled traces in this time range.</p>
              )}
            </div>
          ) : (
            <>
              <TopicsTrendChart rows={rows} days={data.days} />
              <TopicsTable
                rows={rows}
                days={data.days}
                sampled={data.sampled}
                ungrouped={data.ungrouped}
                hrefFor={tracesHref}
              />
              <p className="px-4 py-3 text-[11px] text-muted-foreground">
                Shares are estimates from {data.sampled} sampled{" "}
                {data.sampled === 1 ? "trace" : "traces"} in this range, not from every trace: up to
                300 traces a day are summarized, and the rest have no topic.
                {data.fittedAt && ` Fitted ${new Date(data.fittedAt).toLocaleString()}.`}
              </p>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
