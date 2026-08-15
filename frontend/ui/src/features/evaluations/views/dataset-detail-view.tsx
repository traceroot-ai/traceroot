"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import {
  ArrowDown,
  ArrowUp,
  Database,
  Expand,
  FileText,
  History,
  Plus,
  Shrink,
  SquareArrowOutUpRight,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { CopyButton } from "@/components/ui/copy-button";
import { Select, SelectContent, SelectItem, SelectTrigger } from "@/components/ui/select";
import { Table, TBody, THead, TR, TRHead, Td, Th } from "@/components/ui/table";
import { useToast } from "@/components/ui/toast";
import { useLayout } from "@/components/layout/app-layout";
import { DOMAIN_ICONS } from "@/components/icons/domain-icons";
import { ResizablePanelGroup, ResizablePanel, ResizableHandle } from "@/components/ui/resizable";
import { AiAssistantPanel } from "@/features/ai-assistant/components/ai-assistant-panel";
import { SearchFilterBar } from "@/components/search-filter-bar";
import { ProjectBreadcrumb } from "@/features/projects/components";
import { cn } from "@/lib/utils";
import {
  DatasetActionsMenu,
  EmptyState,
  EvalBody,
  EvalPageHeader,
  Timestamp,
} from "@/features/offline-eval/components";
import { TraceIOSection } from "@/features/traces/components/TraceIOValue";
import { ScoreValue, formatCost, formatElapsed } from "./evaluations-view";
import { caseDisplayId, truncate } from "@/features/offline-eval/utils";
import { versionSnowflake } from "@/lib/eval/snowflake";
import { useDataset, useTestCaseRuns, useDeleteTestCase } from "../hooks";
import {
  TestCaseEditorModal,
  type TestCaseEditorMode,
} from "../components/test-case-editor-modal";
import { DeleteTestCaseDialog } from "../components/delete-test-case-dialog";
import type { TestCaseRow } from "../types";

/** A dash for the list; empty reads as a placeholder, not a blank cell. */
function orDash(value: string | null): React.ReactNode {
  return value && value.trim() !== "" ? value : <span className="text-muted-foreground">-</span>;
}

/** Metadata is stored as unknown JSON; coerce to a flat record for display/edit. */
function asRecord(metadata: unknown): Record<string, unknown> {
  return metadata && typeof metadata === "object" && !Array.isArray(metadata)
    ? (metadata as Record<string, unknown>)
    : {};
}

function metadataPreview(metadata: unknown): React.ReactNode {
  const entries = Object.entries(asRecord(metadata));
  if (entries.length === 0) return <span className="text-muted-foreground">-</span>;
  return (
    <span className="font-mono text-[11px] text-muted-foreground">
      {truncate(entries.map(([k, v]) => `${k}: ${String(v)}`).join(", "), 48)}
    </span>
  );
}

/**
 * Dataset detail — the dataset detail surface, wired to
 * the server.
 *
 * Columns are Created · Input · Expected · Metadata (empty reads as "-"). New
 * row adds an empty test case.
 * offers Duplicate, Add to dataset, and Delete, with an X to cancel. Focusing a
 * row slides in a panel from the right (the way a trace opens) showing the
 * input, expected, and metadata as editable value blocks. Editing publishes a
 * new immutable dataset version — an earlier run's snapshot is never rewritten.
 */
export function DatasetDetailView({
  projectId,
  datasetId,
}: {
  projectId: string;
  datasetId: string;
}) {
  const { toast } = useToast();
  const searchParams = useSearchParams();
  // null = the current version. Selecting an older version loads its snapshot
  // (read-only — editing always branches from the current version).
  const [selectedVersionId, setSelectedVersionId] = React.useState<string | null>(null);
  const { data, isLoading, error, refetch, isFetching } = useDataset(
    projectId,
    datasetId,
    selectedVersionId,
  );
  const del = useDeleteTestCase(projectId, datasetId);

  // "+ Row" and the row action menu open the editor; delete opens a confirm.
  const [editorMode, setEditorMode] = React.useState<TestCaseEditorMode | null>(null);
  const [deleteRow, setDeleteRow] = React.useState<TestCaseRow | null>(null);

  // Hold the stable lineage id (testCaseId), not the per-version row id — a
  // save/review publishes a new version with fresh row ids, and the row id
  // would go dead and unmount the panel out from under the user.
  const [openCaseId, setOpenCaseId] = React.useState<string | null>(null);

  // Deep link: /datasets/[id]?case=<testCaseId> opens that case's panel once (e.g.
  // "View source test case" from an evaluation result). Matched on the stable
  // testCaseId, not the per-version row id.
  const handledCaseParam = React.useRef<string | null>(null);
  React.useEffect(() => {
    const caseParam = searchParams.get("case");
    if (!caseParam || !data || handledCaseParam.current === caseParam) return;
    const match = data.testCases.find((c) => c.testCaseId === caseParam);
    if (match) {
      setOpenCaseId(match.testCaseId);
      handledCaseParam.current = caseParam;
    }
  }, [searchParams, data]);
  // Mirrors CasePanel's dirty flag so the table can prompt before discarding an
  // unsaved edit on row-click, without lifting the whole edit buffer up.
  const dirtyRef = React.useRef(false);
  const [keyword, setKeyword] = React.useState("");

  const dataset = data?.dataset ?? null;
  const versions = React.useMemo(() => data?.versions ?? [], [data]);
  const selectedVersion = data?.selectedVersion ?? null;
  // A freshly created dataset has no versions yet: `isCurrentVersion` computes
  // to `undefined === null` -> false on the server, which would otherwise lock
  // the page read-only before the first row can ever be added.
  const hasVersions = versions.length > 0;
  // While a newly-selected version is still loading, `data` reflects the PREVIOUS
  // snapshot, so treat the page as non-current (read-only) until the fetch settles —
  // otherwise a click mid-fetch would edit/publish against the wrong version.
  const isCurrentVersion = (!hasVersions || (data?.isCurrentVersion ?? true)) && !isFetching;
  const allCases = React.useMemo(() => data?.testCases ?? [], [data]);

  const cases = React.useMemo(() => {
    const q = keyword.trim().toLowerCase();
    if (!q) return allCases;
    return allCases.filter(
      (c) => c.input.toLowerCase().includes(q) || (c.expected ?? "").toLowerCase().includes(q),
    );
  }, [allCases, keyword]);

  // Resolved against allCases (not the keyword-filtered `cases`) and keyed on the
  // stable testCaseId — otherwise typing in the search box, or a save publishing
  // a new version's row ids, would silently unmount the open panel.
  const openCase = openCaseId ? (allCases.find((c) => c.testCaseId === openCaseId) ?? null) : null;
  const confirmDelete = () => {
    if (!deleteRow) return;
    const target = deleteRow;
    del.mutate(target.testCaseId, {
      onSuccess: () => {
        toast({ title: "Row deleted", tone: "success" });
        setDeleteRow(null);
        // Close the slide-in if it was showing the row we just removed.
        if (openCaseId === target.testCaseId) setOpenCaseId(null);
      },
      onError: (e) =>
        toast({ title: "Could not delete the row", description: String(e), tone: "warning" }),
    });
  };

  if (isLoading && !data) {
    return (
      <>
        <ProjectBreadcrumb projectId={projectId} />
        <div className="flex h-64 items-center justify-center text-[13px] text-muted-foreground">
          Loading dataset...
        </div>
      </>
    );
  }
  // Only fall back to a whole-page state when there is genuinely no data to
  // show — not merely on `error`, which `useDataset`'s placeholderData can
  // leave set alongside the *previous* (still-valid) response, e.g. a
  // transient failure while switching versions. That case falls through and
  // renders the page with the last-good snapshot instead of losing it.
  if (!dataset || !data) {
    const notFound = error instanceof Error && /\b404\b/.test(error.message);
    return (
      <>
        <ProjectBreadcrumb projectId={projectId} />
        <div className="flex h-full flex-col text-[13px]">
          <EvalPageHeader
            parent={{ label: "Datasets", href: `/projects/${projectId}/datasets` }}
            title={notFound ? "Dataset not found" : "Couldn't load dataset"}
          />
          <EvalBody>
            <EmptyState>
              {notFound ? (
                <>
                  No dataset with the id {datasetId}.{" "}
                  <Link
                    href={`/projects/${projectId}/datasets`}
                    className="underline underline-offset-2"
                  >
                    Back to datasets
                  </Link>
                </>
              ) : (
                <>
                  Something went wrong loading this dataset.{" "}
                  <button
                    type="button"
                    onClick={() => refetch()}
                    className="underline underline-offset-2"
                  >
                    Try again
                  </button>
                </>
              )}
            </EmptyState>
          </EvalBody>
        </div>
      </>
    );
  }

  return (
    <>
      {/* The dataset name rides in the top breadcrumb bar (Workspace / Project /
          Datasets / <name>) rather than a separate title row, so the page starts
          straight at the toolbar. */}
      <ProjectBreadcrumb
        projectId={projectId}
        trail={[{ label: "Datasets", href: `/projects/${projectId}/datasets` }]}
        current={dataset.name}
      />
      <div className="flex h-full flex-col text-[13px]">
        <div className="flex min-h-0 flex-1 flex-col">
            {/* Single toolbar row: search on the left; the Row action and the
                version selector pushed to the right (version farthest). The version
                id lives inside the dropdown, not spelled out in the bar. No date
                filter: nothing here reads one. */}
            <SearchFilterBar
              searchValue={keyword}
              onSearchChange={setKeyword}
              searchPlaceholder="Search..."
            >
              <div className="ml-auto flex items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 gap-1.5 text-[12px]"
                  onClick={() => setEditorMode({ kind: "create" })}
                  disabled={!isCurrentVersion}
                >
                  <Plus className="h-3.5 w-3.5" aria-hidden />
                  Row
                </Button>
                {hasVersions && (
                  <div className="flex items-center gap-1.5">
                    <span className="text-[12px] text-muted-foreground">Version</span>
                    <Select
                      value={selectedVersion?.id ?? ""}
                      onValueChange={(v) => setSelectedVersionId(v)}
                    >
                      {/* Trigger shows the time-sortable snowflake id;
                          the dropdown pairs each version NUMBER with its snowflake so
                          both the ordering and the exact version id are visible. w-auto
                          hugs the id (no dead gap before the chevron); the dropdown grows
                          to fit its wider "<n>  <snowflake>" rows on its own. */}
                      <SelectTrigger
                        className="h-7 w-auto gap-2 text-[12px]"
                        title="Dataset version"
                      >
                        <span className="whitespace-nowrap font-mono text-[12px]">
                          {selectedVersion
                            ? versionSnowflake(
                                selectedVersion.createTime,
                                selectedVersion.versionNumber,
                              )
                            : "Current version"}
                        </span>
                      </SelectTrigger>
                      <SelectContent align="end">
                        {versions.map((v) => (
                          <SelectItem key={v.id} value={v.id} className="text-[12px]">
                            <span className="flex items-center gap-2">
                              <span className="tabular-nums text-muted-foreground">
                                {v.versionNumber}
                              </span>
                              <span className="font-mono">
                                {versionSnowflake(v.createTime, v.versionNumber)}
                              </span>
                            </span>
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                )}
              </div>
            </SearchFilterBar>

            {/* Table + focused-case slide-in panel */}
            <div className="min-h-0 flex-1 overflow-auto">
              {cases.length === 0 ? (
                <EmptyState>
                  {keyword
                    ? "No cases match your search."
                    : "To populate this dataset, manually create a row or insert data programmatically."}
                </EmptyState>
              ) : (
                <Table>
                  <THead>
                    <TRHead>
                      <Th className="w-[150px]">Created</Th>
                      <Th>Input</Th>
                      <Th>Expected</Th>
                      <Th>Metadata</Th>
                      <Th className="w-[70px] text-right">Actions</Th>
                    </TRHead>
                  </THead>
                  <TBody>
                    {cases.map((tc) => {
                      const openThisCase = () => {
                        if (
                          dirtyRef.current &&
                          !window.confirm("Discard unsaved changes to this case?")
                        ) {
                          return;
                        }
                        setOpenCaseId(tc.testCaseId);
                      };
                      return (
                        <TR
                          key={tc.id}
                          interactive
                          selected={tc.testCaseId === openCaseId}
                          tabIndex={0}
                          role="button"
                          aria-expanded={tc.testCaseId === openCaseId}
                          onClick={openThisCase}
                          onKeyDown={(e) => {
                            if (e.key === "Enter" || e.key === " ") {
                              e.preventDefault();
                              openThisCase();
                            }
                          }}
                        >
                          <Td className="whitespace-nowrap text-muted-foreground">
                            <Timestamp iso={tc.createTime} />
                          </Td>
                          <Td className="max-w-[320px] truncate">{orDash(tc.input || null)}</Td>
                          <Td className="max-w-[320px] truncate">{orDash(tc.expected)}</Td>
                          <Td className="max-w-[240px] truncate">{metadataPreview(tc.metadata)}</Td>
                          <Td className="text-right">
                            {isCurrentVersion && (
                              <DatasetActionsMenu
                                onEdit={() =>
                                  setEditorMode({
                                    kind: "edit",
                                    testCaseId: tc.testCaseId,
                                    input: tc.input,
                                    expected: tc.expected,
                                    metadata: tc.metadata,
                                  })
                                }
                                onDelete={() => setDeleteRow(tc)}
                              />
                            )}
                          </Td>
                        </TR>
                      );
                    })}
                  </TBody>
                </Table>
              )}
            </div>
        </div>
      </div>

      {/* Focused case — slides in from the right like a trace. */}
      {openCase && (
        <CasePanel
          testCase={openCase}
          projectId={projectId}
          datasetId={datasetId}
          versionId={selectedVersion?.id ?? null}
          dirtyRef={dirtyRef}
          onClose={() => setOpenCaseId(null)}
          onNavigate={(dir) => {
            const idx = cases.findIndex((c) => c.testCaseId === openCase.testCaseId);
            const next = dir === "up" ? idx - 1 : idx + 1;
            if (next >= 0 && next < cases.length) setOpenCaseId(cases[next].testCaseId);
          }}
          canNavigateUp={cases.findIndex((c) => c.testCaseId === openCase.testCaseId) > 0}
          canNavigateDown={
            cases.findIndex((c) => c.testCaseId === openCase.testCaseId) < cases.length - 1
          }
        />
      )}

      {/* New / edit row editor. Keyed so switching between rows (or create↔edit)
          remounts it, re-seeding the fields from the fresh target. */}
      {editorMode && (
        <TestCaseEditorModal
          key={editorMode.kind === "edit" ? `edit-${editorMode.testCaseId}` : "create"}
          projectId={projectId}
          datasetId={datasetId}
          mode={editorMode}
          onClose={() => setEditorMode(null)}
          onSaved={() => setSelectedVersionId(null)}
        />
      )}

      {deleteRow && (
        <DeleteTestCaseDialog
          rowLabel={caseDisplayId(deleteRow.testCaseId)}
          isOpen
          onClose={() => setDeleteRow(null)}
          onConfirm={confirmDelete}
          isDeleting={del.isPending}
        />
      )}
    </>
  );
}

/**
 * Slide-in case panel, matching the trace/span detail panel: a header with an
 * icon, the row id, a copy button and the up/down/fullscreen/open-in-new-tab/
 * close controls; then the created date; then a Details/Runs toggle. Input,
 * expected, and metadata render read-only through the same ExpandableSection +
 * ContentRenderer chrome the trace detail uses. In-panel editing is deferred.
 */
function CasePanel({
  testCase,
  projectId,
  datasetId,
  versionId,
  dirtyRef,
  onClose,
  onNavigate,
  canNavigateUp,
  canNavigateDown,
}: {
  testCase: TestCaseRow;
  projectId: string;
  datasetId: string;
  /** The dataset version being viewed; runs that measured a different version of
   *  this row are hidden (their input/expected association differs). */
  versionId: string | null;
  /** Reset to false by this (read-only) panel; kept so the parent can reintroduce
   * an unsaved-changes guard when in-panel editing returns. */
  dirtyRef: React.MutableRefObject<boolean>;
  onClose: () => void;
  onNavigate: (direction: "up" | "down") => void;
  canNavigateUp: boolean;
  canNavigateDown: boolean;
}) {
  const router = useRouter();
  const {
    sidebarCollapsed,
    aiPanelOpen,
    setAiPanelOpen,
    setAiContext,
    setAiInitialSessionId,
    registerAiHost,
  } = useLayout();
  const caseRuns = useTestCaseRuns(projectId, datasetId, testCase.testCaseId);
  // Only runs that measured THIS version of the row — a run on a different dataset
  // version scored a different input/expected, so lumping it in would mislead. When
  // the viewed version is unknown, don't filter.
  const runs = React.useMemo(() => {
    const all = caseRuns.data?.data ?? [];
    return versionId ? all.filter((r) => r.datasetVersionId === versionId) : all;
  }, [caseRuns.data, versionId]);
  const [fullscreen, setFullscreen] = React.useState(false);
  const [view, setView] = React.useState<"details" | "runs">("details");

  // Metadata renders as pretty JSON, matching the trace-detail metadata section.
  const metadataJson = React.useMemo(() => {
    const record = asRecord(testCase.metadata);
    return Object.keys(record).length ? JSON.stringify(record, null, 2) : "";
  }, [testCase.metadata]);

  const copyToClipboard = (value: string) => void navigator.clipboard?.writeText(value);

  // Read-only for now (in-panel editing is deferred), so the parent never needs
  // to guard row switches against unsaved changes.
  React.useEffect(() => {
    dirtyRef.current = false;
  }, [dirtyRef]);

  // Claim the AI slot so AppLayout's project rail steps aside and the assistant
  // renders INSIDE this panel (same as the trace viewer). The returned cleanup
  // runs on unmount, handing the rail back.
  React.useEffect(() => registerAiHost(), [registerAiHost]);

  // Close the assistant when this panel closes. Otherwise, once the panel gives
  // up the AI host slot on unmount, a still-open `aiPanelOpen` would strand the
  // assistant as an empty ~400px panel in the app rail — the "white gap" on the
  // right of the dataset page. Runs before the host-release cleanup above.
  React.useEffect(() => () => setAiPanelOpen(false), [setAiPanelOpen]);

  const panelRef = React.useRef<HTMLDivElement>(null);
  const previousFocusRef = React.useRef<HTMLElement | null>(null);

  // Move focus into the panel on open and restore it to whatever triggered the
  // open (usually the table row) on close, matching the trace/span panel.
  React.useEffect(() => {
    previousFocusRef.current = document.activeElement as HTMLElement | null;
    panelRef.current?.focus();
    return () => {
      previousFocusRef.current?.focus?.();
    };
  }, []);

  // Close on Escape, unless a nested Radix overlay already consumed it in the
  // capture phase — defaultPrevented means "already handled, leave this open".
  React.useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (e.defaultPrevented) return;
      onClose();
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  return (
    <div
      ref={panelRef}
      role="dialog"
      aria-modal="true"
      aria-label={`Test case ${caseDisplayId(testCase.testCaseId)}`}
      tabIndex={-1}
      className={cn(
        "animate-slide-in-right fixed bottom-0 right-0 z-50 flex flex-col border-l border-border bg-background shadow-xl transition-[width,top] duration-200 focus:outline-none",
        fullscreen
          ? sidebarCollapsed
            ? "top-14 w-[calc(100%-3.5rem)]"
            : "top-14 w-[calc(100%-12rem)]"
          : "top-0 w-[70%]",
      )}
    >
      {/* Header — same h-12 chrome as the trace/span detail panel. */}
      <div className="flex h-12 shrink-0 items-center justify-between gap-2 border-b border-border bg-muted/30 px-4">
          <div className="flex min-w-0 items-center gap-2">
            <Database className="h-4 w-4 shrink-0 text-muted-foreground" />
            <span className="text-sm font-medium">Row</span>
            <span className="truncate font-mono text-xs text-muted-foreground">
              {caseDisplayId(testCase.testCaseId)}
            </span>
            <CopyButton
              value={testCase.testCaseId}
              className="h-6 w-6 text-muted-foreground hover:text-foreground"
              title="Copy ID"
            />
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <Button
              variant="outline"
              size="sm"
              onClick={() => onNavigate("up")}
              disabled={!canNavigateUp}
              className="h-7 w-7 p-0"
              title="Previous row"
            >
              <ArrowUp className="h-4 w-4" />
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => onNavigate("down")}
              disabled={!canNavigateDown}
              className="h-7 w-7 p-0"
              title="Next row"
            >
              <ArrowDown className="h-4 w-4" />
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setFullscreen((v) => !v)}
              className="h-7 w-7 p-0"
              title={fullscreen ? "Restore default size" : "Expand to full screen"}
            >
              {fullscreen ? <Shrink className="h-4 w-4" /> : <Expand className="h-4 w-4" />}
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => window.open(`/projects/${projectId}/datasets/${datasetId}`, "_blank")}
              className="h-7 w-7 p-0"
              title="Open in new tab"
            >
              <SquareArrowOutUpRight className="h-4 w-4" />
            </Button>
            <div className="w-2" />
            {/* AI Assistant — mirrors the trace-detail panel. Seeds the case's source
                trace as context when it has one; otherwise a plain project-scoped chat. */}
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setAiContext(testCase.sourceTraceId ? { traceId: testCase.sourceTraceId } : null);
                setAiInitialSessionId(undefined);
                setAiPanelOpen(!aiPanelOpen);
              }}
              className="h-7 w-7 p-0"
              title="AI Assistant"
            >
              <DOMAIN_ICONS.assistant className="h-4 w-4" />
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="h-7 w-7 p-0"
              onClick={onClose}
              aria-label="Close"
            >
              <X className="h-4 w-4" />
            </Button>
          </div>
      </div>

      {/* View toggle — Row / Experiments, where a trace shows Tree / Timeline. The
          `details`/`runs` state keys stay internal. */}
      <div className="flex h-10 shrink-0 items-center border-b border-border px-2">
        <button
          type="button"
          onClick={() => setView("details")}
          className={cn(
            "flex items-center gap-2 rounded-md px-3 py-1 text-xs font-medium transition-all",
            view === "details"
              ? "bg-muted text-foreground shadow-sm"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          <FileText className="h-3.5 w-3.5" /> Row
        </button>
        <button
          type="button"
          onClick={() => setView("runs")}
          className={cn(
            "flex items-center gap-2 rounded-md px-3 py-1 text-xs font-medium transition-all",
            view === "runs"
              ? "bg-muted text-foreground shadow-sm"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          <History className="h-3.5 w-3.5" /> Experiments
          {runs.length > 0 && (
            <span className="rounded bg-muted px-1 text-[10px] tabular-nums text-muted-foreground">
              {runs.length}
            </span>
          )}
        </button>
      </div>

      {/* Content area split: [ details/runs | AI assistant (optional) ], exactly
          like the trace viewer, so the agent button opens an in-panel chat. */}
      <div className="relative flex min-h-0 flex-1 overflow-hidden">
        <ResizablePanelGroup orientation="horizontal" className="h-full min-w-0">
          <ResizablePanel id="case-main" minSize="360px" className="min-w-0 overflow-hidden">
            {view === "details" ? (
              // Read-only view — same chrome as the trace/span detail panel: a plain
              // block-flow scroll region (space-y, NOT flex) so each section keeps its
              // full height and the panel scrolls, instead of the sections compressing.
              <div className="h-full space-y-3 overflow-y-auto p-4">
                <TraceIOSection
                  key={`input-${testCase.id}`}
                  title="Input"
                  content={testCase.input}
                  onCopy={testCase.input ? () => copyToClipboard(testCase.input) : undefined}
                />
                <TraceIOSection
                  key={`expected-${testCase.id}`}
                  title="Expected"
                  content={testCase.expected}
                  onCopy={testCase.expected ? () => copyToClipboard(testCase.expected!) : undefined}
                />
                <TraceIOSection
                  key={`metadata-${testCase.id}`}
                  title="Metadata"
                  content={metadataJson || null}
                  onCopy={metadataJson ? () => copyToClipboard(metadataJson) : undefined}
                />
              </div>
            ) : runs.length === 0 ? (
              <div className="h-full overflow-auto p-4">
                <EmptyState>
                  No run has measured this row on the dataset version you’re viewing. Runs that
                  measured a different version aren’t shown here.
                </EmptyState>
              </div>
            ) : (
              // Edge-to-edge table (no inset padding), so it reads like the Experiments
              // list page rather than a boxed card floating in whitespace.
              <div className="h-full overflow-auto">
                <Table>
                  <THead>
                    <TRHead>
                      <Th className="w-[150px]">Timestamp</Th>
                      <Th>Experiment Name</Th>
                      <Th>Run Name</Th>
                      <Th className="w-[90px] text-right">Score</Th>
                      <Th className="w-[90px] text-right">Cost</Th>
                      <Th className="w-[90px] text-right">Avg Cost</Th>
                      <Th className="w-[90px] text-right">Duration</Th>
                      <Th className="w-[100px] text-right">Avg Duration</Th>
                    </TRHead>
                  </THead>
                  <TBody>
                    {runs.map((r) => {
                      // Run-level averages, same math as the Experiments list.
                      const avgCost = r.cost != null && r.caseCount > 0 ? r.cost / r.caseCount : null;
                      const avgDurationMs =
                        r.elapsedMs != null && r.caseCount > 0
                          ? Math.round(r.elapsedMs / r.caseCount)
                          : null;
                      return (
                        <TR
                          key={r.resultId}
                          interactive
                          onClick={() =>
                            router.push(`/projects/${projectId}/evaluations/${r.runId}`)
                          }
                        >
                          <Td className="whitespace-nowrap text-muted-foreground">
                            <Timestamp iso={r.ranAt} />
                          </Td>
                          <Td className="text-foreground">{r.evaluationName}</Td>
                          <Td className="whitespace-nowrap">
                            <span className="font-mono">{r.candidateVersion}</span>{" "}
                            <span className="tabular-nums text-muted-foreground">
                              #{r.runNumber}
                            </span>
                          </Td>
                          <Td className="text-right tabular-nums">
                            <ScoreValue value={r.score} />
                          </Td>
                          <Td className="text-right tabular-nums text-muted-foreground">
                            {formatCost(r.cost)}
                          </Td>
                          <Td className="text-right tabular-nums text-muted-foreground">
                            {formatCost(avgCost)}
                          </Td>
                          <Td className="whitespace-nowrap text-right tabular-nums text-muted-foreground">
                            {formatElapsed(r.elapsedMs)}
                          </Td>
                          <Td className="whitespace-nowrap text-right tabular-nums text-muted-foreground">
                            {formatElapsed(avgDurationMs)}
                          </Td>
                        </TR>
                      );
                    })}
                  </TBody>
                </Table>
              </div>
            )}
          </ResizablePanel>

          {aiPanelOpen && (
            <>
              <ResizableHandle />
              <ResizablePanel
                id="case-ai-chat"
                defaultSize="31%"
                minSize="320px"
                maxSize="45%"
                className="min-w-0 border-l border-border bg-background"
              >
                <AiAssistantPanel
                  projectId={projectId}
                  compact
                  onClose={() => {
                    setAiPanelOpen(false);
                    setAiContext(null);
                    setAiInitialSessionId(undefined);
                  }}
                />
              </ResizablePanel>
            </>
          )}
        </ResizablePanelGroup>
      </div>
    </div>
  );
}
