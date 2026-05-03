"use client";

import { useEffect, useState } from "react";
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
  const [selectedFinding, setSelectedFinding] = useState<BackendFinding | null>(null);

  // Single shared state across both tabs — same pattern as traces/sessions/users.
  // Pagination, search, and date filter live in the URL so a tab switch keeps
  // them; `defaultDateFilter` is the only detector-specific deviation (#806).
  const {
    state,
    queryOptions,
    updateDateFilter,
    updateCustomRange,
    updateKeyword,
    updateLimit,
    goToPage,
  } = useListPageState();

  const { data: detectorsData } = useDetectors(projectId);
  const detector = detectorsData?.find((d) => d.id === detectorId);

  const { data: findingsData, isLoading, error } = useFindings(projectId, detectorId, queryOptions);

  const {
    data: runsData,
    isLoading: runsLoading,
    error: runsError,
  } = useRuns(projectId, detectorId, queryOptions);

  const findings = findingsData?.data ?? [];
  const runs = runsData?.data ?? [];

  // Active tab's meta drives pagination. Both tabs share the same page/limit
  // since `useListPageState` is one shared instance — switching tabs keeps you
  // on the same page index. The other tab's data may show empty if it has
  // fewer pages; clicking "first" recovers.
  const meta = (activeTab === "runs" ? runsData?.meta : findingsData?.meta) || {
    page: 0,
    limit: 50,
    total: 0,
  };
  const totalPages = Math.ceil(meta.total / meta.limit);

  // Clear `selectedFinding` if the row it points to is no longer in the
  // current findings list (e.g. user paginated, refetched, or filtered).
  useEffect(() => {
    if (selectedFinding && !findings.some((f) => f.finding_id === selectedFinding.finding_id)) {
      setSelectedFinding(null);
    }
  }, [findings, selectedFinding]);

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

        {/* Filter bar — identical instantiation to traces/sessions/users. */}
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
              <div className="flex h-64 flex-col items-center justify-center gap-3">
                <p className="text-[13px] text-muted-foreground">No runs found</p>
                <p className="text-[12px] text-muted-foreground">
                  Try adjusting your filters or date range.
                </p>
              </div>
            ) : (
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
                      <td className="px-3 py-1.5 text-[12px] text-muted-foreground">{e.status}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
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
            <div className="flex h-64 flex-col items-center justify-center gap-3">
              <p className="text-[13px] text-muted-foreground">No findings found</p>
              <p className="text-[12px] text-muted-foreground">
                Try adjusting your filters or date range.
              </p>
            </div>
          ) : (
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
                      setSelectedFinding(selectedFinding?.finding_id === f.finding_id ? null : f)
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
          )}
        </div>

        {/* Pagination — copied from traces/page.tsx so the detector page
            renders an identical control: items-per-page popover, typeable
            page input, and first/prev/next/last navigation buttons. */}
        {((activeTab === "findings" && findings.length > 0) ||
          (activeTab === "runs" && runs.length > 0)) && (
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
        )}
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
