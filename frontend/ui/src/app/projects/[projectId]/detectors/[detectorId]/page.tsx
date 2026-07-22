"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { ChevronRight, Flag, History } from "lucide-react";
import { SearchFilterBar } from "@/components/search-filter-bar";
import { ListPagination } from "@/components/list-pagination";
import { ProjectBreadcrumb } from "@/features/projects/components";
import { cn, buildUrlWithFilters } from "@/lib/utils";
import { useDetector } from "@/features/detectors/hooks/use-detectors";
import { useRuns, selfTraceId, type BackendRun } from "@/features/detectors/hooks/use-findings";
import { DetectorRunsTable } from "@/features/detectors/components/detector-runs-table";
import { useListPageState } from "@/lib/hooks/use-list-page-state";
import { DETECTORS_DEFAULT_DATE_FILTER_ID } from "@/lib/date-filter";
import { TraceViewerPanel } from "@/features/traces/components/TraceViewerPanel";

/**
 * Which trace the consolidated panel shows. `kind` selects RCA auto-open:
 * "original" (the run's source trace) opens its RCA when one exists; "self"
 * (the detector's own analysis trace — Section 3) opens quietly. Today only
 * "original" is produced; the "self" path is wired but unused.
 */
type SelectedTrace = { traceId: string; kind: "original" | "self" } | null;

// A self-trace is identified by its run row (dashless run_id), not by a
// trace_id in the list, so match on the right key per kind. Module-scope so
// effects can use it without a dependency-list entry.
const rowMatchesSelection = (r: BackendRun, sel: SelectedTrace) =>
  sel != null &&
  (sel.kind === "self" ? selfTraceId(r) === sel.traceId : r.trace_id === sel.traceId);

const tabs = [
  { id: "findings", label: "Findings", icon: Flag },
  { id: "runs", label: "Runs", icon: History },
];

export default function DetectorDetailPage() {
  const params = useParams();
  const router = useRouter();
  const searchParams = useSearchParams();
  const projectId = params.projectId as string;
  const detectorId = params.detectorId as string;

  // Deep-link params: set when a trace is popped out into a new tab from the
  // panel's "open in new tab" button (or linked from a trace's Detectors tab),
  // so it reopens here in the detector tab. source=detector marks the id as a
  // self-trace (dashless run_id), which matches run rows, not trace ids.
  const traceIdFromUrl = searchParams.get("traceId");
  const sourceFromUrl = searchParams.get("source");
  const [startFullscreen, setStartFullscreen] = useState(searchParams.get("fullscreen") === "1");
  const [didAutoOpen, setDidAutoOpen] = useState(false);

  // Deep-link the tab (e.g. the trace detectors tab sends clean runs to "runs"
  // and findings to "findings"); default to findings for any other value.
  const tabParam = searchParams.get("tab");
  const [activeTab, setActiveTab] = useState(tabParam === "runs" ? "runs" : "findings");
  // Re-honor ?tab= when it changes without a remount (navigating detector→detector
  // from the trace panel's Detectors table). Keyed on the param value only, so a
  // manual tab switch — which doesn't touch the URL — is never overridden.
  useEffect(() => {
    if (tabParam === "runs" || tabParam === "findings") setActiveTab(tabParam);
  }, [tabParam]);
  const [selectedTrace, setSelectedTrace] = useState<SelectedTrace>(null);

  // Single shared state across both tabs — same pattern as traces/sessions/users.
  // Pagination, search, and date filter live in the URL so a tab switch keeps them.
  const {
    state,
    queryOptions,
    updateDateFilter,
    updateCustomRange,
    updateKeyword,
    updateLimit,
    goToPage,
  } = useListPageState({ defaultDateFilterId: DETECTORS_DEFAULT_DATE_FILTER_ID });

  // Carry the selected range back to the list (and into the breadcrumb) so the
  // detectors section keeps one consistent time range across navigation, the
  // same way the Traces tabs propagate it through the URL.
  const buildUrl = (path: string) =>
    buildUrlWithFilters(path, {
      dateFilter: state.dateFilter,
      customStartDate: state.customStartDate,
      customEndDate: state.customEndDate,
    });

  const { data: detector } = useDetector(projectId, detectorId);

  // The Findings tab is a filtered Runs view: the same runs query restricted to
  // triggered runs (identified = Yes, i.e. finding_id IS NOT NULL).
  const {
    data: findingsData,
    isLoading,
    error,
  } = useRuns(projectId, detectorId, { ...queryOptions, identified: true });

  const {
    data: runsData,
    isLoading: runsLoading,
    error: runsError,
  } = useRuns(projectId, detectorId, queryOptions);

  const findings = findingsData?.data ?? [];
  const runs = runsData?.data ?? [];

  // The active tab's rows back both pagination and the panel's ↑/↓ navigation.
  const activeRows = activeTab === "runs" ? runs : findings;

  // Active tab's meta drives pagination. Both tabs share the same page/limit
  // since `useListPageState` is one shared instance — switching tabs keeps you
  // on the same page index. The other tab's data may show empty if it has
  // fewer pages; clicking "first" recovers.
  const activeMeta = activeTab === "runs" ? runsData?.meta : findingsData?.meta;

  // Clicking a row's trace_id cell opens that run's original trace, with its RCA
  // auto-opening if one exists (the panel gates auto-open on a real RCA session,
  // so clean traces open quietly).
  const openOriginalTrace = (run: BackendRun) =>
    setSelectedTrace({ traceId: run.trace_id, kind: "original" });

  // Clicking a self-traced run's run_id cell opens the run's own trace.
  const openSelfTrace = (run: BackendRun) =>
    setSelectedTrace({ traceId: selfTraceId(run), kind: "self" });

  // Clear the selection if its run/trace is no longer in the active list (e.g. the
  // user paginated, refetched, switched tabs, or changed filters).
  useEffect(() => {
    if (selectedTrace && !activeRows.some((r) => rowMatchesSelection(r, selectedTrace))) {
      setSelectedTrace(null);
    }
  }, [activeRows, selectedTrace]);

  // Deep-link: when arriving with ?traceId=... (popped out from another tab or
  // linked from a trace's Detectors tab), open that trace once the list has
  // loaded. Runs once, so closing the panel doesn't reopen it.
  useEffect(() => {
    if (didAutoOpen || !traceIdFromUrl) return;
    const sel: SelectedTrace = {
      traceId: traceIdFromUrl,
      kind: sourceFromUrl === "detector" ? "self" : "original",
    };
    if (activeRows.some((r) => rowMatchesSelection(r, sel))) {
      setSelectedTrace(sel);
      setDidAutoOpen(true);
    }
  }, [didAutoOpen, traceIdFromUrl, sourceFromUrl, activeRows]);

  const selectedIndex = selectedTrace
    ? activeRows.findIndex((r) => rowMatchesSelection(r, selectedTrace))
    : -1;

  // Up/down steps through original traces only; a self-trace is a point-open with
  // no natural sequence (adjacent rows may not be self-traced).
  const canNavigate = selectedTrace?.kind === "original";

  function handleNavigate(direction: "up" | "down") {
    if (!canNavigate || selectedIndex === -1) return;
    const nextIndex = direction === "up" ? selectedIndex - 1 : selectedIndex + 1;
    if (nextIndex >= 0 && nextIndex < activeRows.length) {
      setSelectedTrace({ traceId: activeRows[nextIndex].trace_id, kind: "original" });
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
            onClick={() => router.push(buildUrl(`/projects/${projectId}/detectors`))}
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

        {/* Content — both tabs render the same DetectorRunsTable; Findings is
            just the runs query filtered to triggered runs (identified=true). */}
        <div className="flex-1 overflow-auto bg-background">
          {(() => {
            const loading = activeTab === "runs" ? runsLoading : isLoading;
            const err = activeTab === "runs" ? runsError : error;
            const noun = activeTab === "runs" ? "runs" : "findings";

            if (loading) {
              return (
                <div className="flex h-64 items-center justify-center">
                  <p className="text-[13px] text-muted-foreground">Loading {noun}...</p>
                </div>
              );
            }
            if (err) {
              return (
                <div className="flex h-64 flex-col items-center justify-center gap-3">
                  <p className="text-[13px] text-destructive">Error loading {noun}</p>
                </div>
              );
            }
            if (activeRows.length === 0) {
              return (
                <div className="flex h-64 flex-col items-center justify-center gap-3">
                  <p className="text-[13px] text-muted-foreground">No {noun} found</p>
                  <p className="text-[12px] text-muted-foreground">
                    Try adjusting your filters or date range.
                  </p>
                </div>
              );
            }
            return (
              <DetectorRunsTable
                rows={activeRows}
                onTraceClick={openOriginalTrace}
                onRunClick={openSelfTrace}
              />
            );
          })()}
        </div>

        <ListPagination
          page={state.page}
          limit={state.limit}
          total={activeMeta?.total ?? 0}
          onPageChange={goToPage}
          onLimitChange={updateLimit}
        />
      </div>

      {/* Detail panel — one TraceViewerPanel mount for the selected trace.
          autoOpenRca only for "original" traces (the panel still gates auto-open
          on a real RCA session, so clean traces open quietly). */}
      {selectedTrace && (
        <TraceViewerPanel
          projectId={projectId}
          traceId={selectedTrace.traceId}
          onClose={() => {
            setSelectedTrace(null);
            setStartFullscreen(false);
          }}
          onNavigate={handleNavigate}
          canNavigateUp={canNavigate && selectedIndex > 0}
          canNavigateDown={
            canNavigate && selectedIndex !== -1 && selectedIndex < activeRows.length - 1
          }
          dateFilter={state.dateFilter}
          customStartDate={state.customStartDate}
          customEndDate={state.customEndDate}
          autoOpenRca={selectedTrace.kind === "original"}
          initialFullscreen={startFullscreen}
          newTabPath={`/projects/${projectId}/detectors/${detectorId}`}
          source={selectedTrace.kind === "self" ? "detector" : "user"}
        />
      )}
    </div>
  );
}
