"use client";

import { useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { ChevronLeft, ChevronRight, ChevronDown, Flag, History } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { SearchFilterBar } from "@/components/search-filter-bar";
import { ProjectBreadcrumb } from "@/features/projects/components";
import { formatDate, cn } from "@/lib/utils";
import { useDetectors } from "@/features/detectors/hooks/use-detectors";
import { useFindings, useRuns, type BackendFinding } from "@/features/detectors/hooks/use-findings";
import { useListPageState } from "@/features/traces/hooks";
import { TraceViewerPanel } from "@/features/traces/components/TraceViewerPanel";

const tabs = [
  { id: "findings", label: "Findings", icon: Flag },
  { id: "runs", label: "Runs", icon: History },
];

export default function DetectorDetailPage() {
  const params = useParams();
  const router = useRouter();
  const projectId = params.projectId as string;
  const detectorId = params.detectorId as string;

  const [activeTab, setActiveTab] = useState("findings");
  const [itemsPerPageOpen, setItemsPerPageOpen] = useState(false);
  const [runsItemsPerPageOpen, setRunsItemsPerPageOpen] = useState(false);
  const [selectedFinding, setSelectedFinding] = useState<BackendFinding | null>(null);

  const { state, updateDateFilter, updateCustomRange, updateKeyword, updateLimit, goToPage } =
    useListPageState();

  const [runsPage, setRunsPage] = useState(0);
  const [runsLimit, setRunsLimit] = useState(50);

  const { data: detectorsData } = useDetectors(projectId);
  const detector = detectorsData?.find((d) => d.id === detectorId);

  const limit = state.limit;
  const offset = state.page * limit;

  const {
    data: findingsData,
    isLoading,
    error,
  } = useFindings(projectId, detectorId, {
    limit,
    offset,
  });

  const findings = findingsData?.findings ?? [];
  const hasMore = findings.length === limit;

  const {
    data: runsData,
    isLoading: runsLoading,
    error: runsError,
  } = useRuns(projectId, detectorId, {
    limit: runsLimit,
    offset: runsPage * runsLimit,
  });

  const runs = runsData?.runs ?? [];
  const runsHasMore = runs.length === runsLimit;

  const selectedIndex = selectedFinding
    ? findings.findIndex((f) => f.finding_id === selectedFinding.finding_id)
    : -1;

  function handleNavigate(direction: "up" | "down") {
    if (selectedIndex === -1) return;
    const nextIndex = direction === "up" ? selectedIndex - 1 : selectedIndex + 1;
    if (nextIndex >= 0 && nextIndex < findings.length) {
      setSelectedFinding(findings[nextIndex]);
    }
  }

  return (
    <div className="relative flex h-full text-[13px]">
      <ProjectBreadcrumb projectId={projectId} />

      <div className="flex flex-1 flex-col overflow-hidden">
        {/* Page header */}
        <div className="flex items-center gap-2 border-b border-border px-4 py-3">
          <button
            type="button"
            onClick={() => router.push(`/projects/${projectId}/detectors`)}
            className="text-[13px] text-muted-foreground transition-colors hover:text-foreground"
          >
            Detectors
          </button>
          <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
          <span className="text-[13px] font-medium">{detector?.name ?? detectorId}</span>
        </div>

        {/* Tabs */}
        <div className="border-b border-border bg-background">
          <div className="flex">
            {tabs.map((tab) => {
              const Icon = tab.icon;
              const isActive = activeTab === tab.id;
              return (
                <button
                  key={tab.id}
                  type="button"
                  onClick={() => setActiveTab(tab.id)}
                  className={cn(
                    "flex items-center gap-1.5 border-b-2 px-3 py-1.5 text-[13px] font-medium transition-colors",
                    isActive
                      ? "border-foreground bg-muted text-foreground"
                      : "border-transparent text-muted-foreground hover:bg-muted/50 hover:text-foreground",
                  )}
                >
                  <Icon className="h-3.5 w-3.5" />
                  {tab.label}
                </button>
              );
            })}
          </div>
        </div>

        {/* Filter bar */}
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

        {/* Content area */}
        <div className="flex-1 overflow-auto bg-background">
          {activeTab === "runs" ? (
            runsLoading ? (
              <div className="flex h-64 items-center justify-center">
                <p className="text-[13px] text-muted-foreground">Loading runs...</p>
              </div>
            ) : runsError ? (
              <div className="flex h-64 flex-col items-center justify-center gap-3">
                <p className="text-[13px] text-destructive">Error loading runs</p>
              </div>
            ) : runs.length === 0 ? (
              <div className="flex h-64 flex-col items-center justify-center gap-2">
                <History className="h-8 w-8 text-muted-foreground/40" />
                <p className="text-[13px] text-muted-foreground">No runs yet</p>
                <p className="text-[12px] text-muted-foreground">
                  Per-trace evaluation run history will appear here.
                </p>
              </div>
            ) : (
              <div className="flex h-full flex-col">
                <div className="flex-1 overflow-auto">
                  <table className="w-full">
                    <thead className="sticky top-0 bg-background">
                      <tr className="border-b border-border bg-muted/50">
                        <th className="w-[160px] border-r border-border/50 px-3 py-1.5 text-left text-[12px] font-medium text-muted-foreground">
                          Timestamp
                        </th>
                        <th className="w-[280px] border-r border-border/50 px-3 py-1.5 text-left text-[12px] font-medium text-muted-foreground">
                          Run ID
                        </th>
                        <th className="border-r border-border/50 px-3 py-1.5 text-left text-[12px] font-medium text-muted-foreground">
                          Trace ID
                        </th>
                        <th className="w-[80px] border-r border-border/50 px-3 py-1.5 text-left text-[12px] font-medium text-muted-foreground">
                          Identified
                        </th>
                        <th className="w-[280px] border-r border-border/50 px-3 py-1.5 text-left text-[12px] font-medium text-muted-foreground">
                          Finding ID
                        </th>
                        <th className="border-r border-border/50 px-3 py-1.5 text-left text-[12px] font-medium text-muted-foreground">
                          Summary
                        </th>
                        <th className="w-[90px] px-3 py-1.5 text-left text-[12px] font-medium text-muted-foreground">
                          Status
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {runs.map((e) => (
                        <tr
                          key={e.run_id}
                          className="border-b border-border/50 transition-colors last:border-0 hover:bg-muted/50"
                        >
                          <td className="whitespace-nowrap border-r border-border/50 px-3 py-1.5 text-[12px] text-muted-foreground">
                            {formatDate(e.timestamp)}
                          </td>
                          <td className="border-r border-border/50 px-3 py-1.5 font-mono text-[11px] text-muted-foreground">
                            {e.run_id}
                          </td>
                          <td className="border-r border-border/50 px-3 py-1.5 font-mono text-[11px] text-muted-foreground">
                            {e.trace_id}
                          </td>
                          <td className="border-r border-border/50 px-3 py-1.5 text-[12px]">
                            {e.finding_id != null ? (
                              <span className="text-destructive">Yes</span>
                            ) : (
                              <span className="text-muted-foreground">No</span>
                            )}
                          </td>
                          <td className="border-r border-border/50 px-3 py-1.5 font-mono text-[11px] text-muted-foreground">
                            {e.finding_id ?? "—"}
                          </td>
                          <td className="max-w-[400px] border-r border-border/50 px-3 py-1.5 text-[12px] text-foreground">
                            {e.summary ? (
                              <span className="block truncate" title={e.summary}>
                                {e.summary.length > 100 ? e.summary.slice(0, 100) + "…" : e.summary}
                              </span>
                            ) : (
                              <span className="font-mono text-[11px] text-muted-foreground">—</span>
                            )}
                          </td>
                          <td className="px-3 py-1.5 text-[12px] text-muted-foreground">
                            {e.status}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                {/* Runs pagination */}
                <div className="flex items-center justify-end gap-6 border-t border-border bg-background px-4 py-2.5">
                  <div className="flex items-center gap-2">
                    <span className="text-[12px] text-muted-foreground">Items per page</span>
                    <Popover open={runsItemsPerPageOpen} onOpenChange={setRunsItemsPerPageOpen}>
                      <PopoverTrigger asChild>
                        <Button
                          variant="outline"
                          size="sm"
                          className="h-7 min-w-[60px] justify-between px-2 text-[12px]"
                        >
                          <span>{runsLimit}</span>
                          <ChevronDown className="ml-1 h-3 w-3 text-muted-foreground" />
                        </Button>
                      </PopoverTrigger>
                      <PopoverContent side="top" align="start" className="w-[80px] p-1">
                        {[50, 100, 200].map((value) => (
                          <button
                            key={value}
                            className={cn(
                              "w-full rounded-md px-2.5 py-1.5 text-left text-[12px] transition-colors",
                              runsLimit === value ? "bg-muted" : "hover:bg-muted/50",
                            )}
                            onClick={() => {
                              setRunsLimit(value);
                              setRunsPage(0);
                              setRunsItemsPerPageOpen(false);
                            }}
                          >
                            {value}
                          </button>
                        ))}
                      </PopoverContent>
                    </Popover>
                  </div>
                  <div className="flex items-center gap-0.5">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setRunsPage(Math.max(0, runsPage - 1))}
                      disabled={runsPage === 0}
                      className="h-7 w-7 p-0"
                    >
                      <ChevronLeft className="h-3.5 w-3.5" />
                    </Button>
                    <span className="px-2 text-[12px] text-muted-foreground">
                      Page {runsPage + 1}
                    </span>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setRunsPage(runsPage + 1)}
                      disabled={!runsHasMore}
                      className="h-7 w-7 p-0"
                    >
                      <ChevronRight className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </div>
              </div>
            )
          ) : isLoading ? (
            <div className="flex h-64 items-center justify-center">
              <p className="text-[13px] text-muted-foreground">Loading findings...</p>
            </div>
          ) : error ? (
            <div className="flex h-64 flex-col items-center justify-center gap-3">
              <p className="text-[13px] text-destructive">Error loading findings</p>
            </div>
          ) : findings.length === 0 ? (
            <div className="flex h-64 flex-col items-center justify-center gap-2">
              <Flag className="h-8 w-8 text-muted-foreground/40" />
              <p className="text-[13px] text-muted-foreground">No findings yet</p>
              <p className="text-[12px] text-muted-foreground">
                Findings appear when this detector flags a trace.
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
                      <th className="w-[280px] border-r border-border/50 px-3 py-1.5 text-left text-[12px] font-medium text-muted-foreground">
                        Finding ID
                      </th>
                      <th className="w-[280px] border-r border-border/50 px-3 py-1.5 text-left text-[12px] font-medium text-muted-foreground">
                        Trace ID
                      </th>
                      <th className="px-3 py-1.5 text-left text-[12px] font-medium text-muted-foreground">
                        Summary
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {findings.map((f) => (
                      <tr
                        key={f.finding_id}
                        onClick={() =>
                          setSelectedFinding(
                            selectedFinding?.finding_id === f.finding_id ? null : f,
                          )
                        }
                        className={cn(
                          "cursor-pointer border-b border-border/50 transition-colors last:border-0",
                          selectedFinding?.finding_id === f.finding_id
                            ? "bg-muted"
                            : "hover:bg-muted/50",
                        )}
                      >
                        <td className="whitespace-nowrap border-r border-border/50 px-3 py-1.5 text-[12px] text-muted-foreground">
                          {formatDate(f.timestamp)}
                        </td>
                        <td className="border-r border-border/50 px-3 py-1.5 font-mono text-[11px] text-muted-foreground">
                          {f.finding_id}
                        </td>
                        <td className="w-[280px] border-r border-border/50 px-3 py-1.5 font-mono text-[11px] text-muted-foreground">
                          <span className="block truncate" title={f.trace_id}>
                            {f.trace_id}
                          </span>
                        </td>
                        <td className="max-w-[400px] px-3 py-1.5 text-[12px] text-foreground">
                          <span className="block truncate" title={f.summary}>
                            {f.summary.length > 100 ? f.summary.slice(0, 100) + "…" : f.summary}
                          </span>
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
                        <span>{limit}</span>
                        <ChevronDown className="ml-1 h-3 w-3 text-muted-foreground" />
                      </Button>
                    </PopoverTrigger>
                    <PopoverContent side="top" align="start" className="w-[80px] p-1">
                      {[50, 100, 200].map((value) => (
                        <button
                          key={value}
                          className={cn(
                            "w-full rounded-md px-2.5 py-1.5 text-left text-[12px] transition-colors",
                            limit === value ? "bg-muted" : "hover:bg-muted/50",
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
                <div className="flex items-center gap-0.5">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => goToPage(Math.max(0, state.page - 1))}
                    disabled={state.page === 0}
                    className="h-7 w-7 p-0"
                  >
                    <ChevronLeft className="h-3.5 w-3.5" />
                  </Button>
                  <span className="px-2 text-[12px] text-muted-foreground">
                    Page {state.page + 1}
                  </span>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => goToPage(state.page + 1)}
                    disabled={!hasMore}
                    className="h-7 w-7 p-0"
                  >
                    <ChevronRight className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Detail panel — fixed overlay sliding in from right, same pattern as traces page */}
      {selectedFinding && (
        <div className="animate-slide-in-right fixed bottom-0 right-0 top-0 z-50 w-[70%] border-l border-border bg-background shadow-xl">
          <TraceViewerPanel
            projectId={projectId}
            traceId={selectedFinding.trace_id}
            onClose={() => setSelectedFinding(null)}
            onNavigate={handleNavigate}
            canNavigateUp={selectedIndex > 0}
            canNavigateDown={selectedIndex < findings.length - 1}
            dateFilter={state.dateFilter}
            customStartDate={state.customStartDate}
            customEndDate={state.customEndDate}
            autoOpenRca={true}
          />
        </div>
      )}
    </div>
  );
}
