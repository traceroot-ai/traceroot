"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import {
  ArrowDown,
  ArrowUp,
  ChevronRight,
  Copy,
  Database,
  Download,
  Expand,
  FileCode,
  FileText,
  History,
  Play,
  Plus,
  Shrink,
  SquareArrowOutUpRight,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { CopyButton } from "@/components/ui/copy-button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Table, TBody, THead, TR, TRHead, Td, Th } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useToast } from "@/components/ui/toast";
import { useLayout } from "@/components/layout/app-layout";
import { SearchFilterBar } from "@/components/search-filter-bar";
import { DATE_FILTER_OPTIONS, type DateFilterOption } from "@/lib/date-filter";
import { ProjectBreadcrumb } from "@/features/projects/components";
import { SpanKindIcon } from "@/features/traces";
import { cn } from "@/lib/utils";
import {
  EmptyState,
  EvalBody,
  EvalPageHeader,
  ReviewBadge,
  EditableValueBlock,
  EvalResultBadge,
  SelectAllHeaderCell,
  SelectRowCell,
  Timestamp,
  UploadControl,
  useRowSelection,
  TestCaseReviewDrawer,
  type TestCaseReviewTarget,
} from "@/features/offline-eval/components";
import { CAPTURE_REASON_LABEL, type ReviewStatus } from "@/features/offline-eval/types";
import {
  caseDisplayId,
  changeSentiment,
  pct,
  scoreDisplay,
  SENTIMENT_CLASS,
  truncate,
} from "@/features/offline-eval/utils";
import {
  useDataset,
  useDatasets,
  useSaveTestCase,
  useUpdateTestCase,
  useEvaluationRuns,
  useTestCaseRuns,
} from "../hooks";
import type { TestCaseRow } from "../types";
import { RunEvaluationDrawer } from "../components/run-evaluation-drawer";
import { DatasetPullCodeDrawer } from "../components/dataset-pull-code-drawer";

/** "Last 14 days" default, matching the traces/datasets lists. */
const DEFAULT_DATE_FILTER =
  DATE_FILTER_OPTIONS.find((o) => o.id === "14d") ?? DATE_FILTER_OPTIONS[0];

/** Map a per-case change direction to a signed delta for the sentiment colour. */
const CHANGE_DELTA: Record<"improved" | "regressed" | "unchanged", number> = {
  improved: 1,
  regressed: -1,
  unchanged: 0,
};

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
 * Dataset detail — a faithful port of the prototype's dataset detail, wired to
 * the server.
 *
 * Columns are Created · Input · Expected · Metadata (empty reads as "-"). New
 * row adds an empty test case; Import is a centered dialog. Selecting rows
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
  const router = useRouter();
  const searchParams = useSearchParams();
  // null = the current version. Selecting an older version loads its snapshot
  // (read-only — editing always branches from the current version).
  const [selectedVersionId, setSelectedVersionId] = React.useState<string | null>(null);
  const { data, isLoading, error } = useDataset(projectId, datasetId, selectedVersionId);
  const save = useSaveTestCase(projectId, datasetId);
  const update = useUpdateTestCase(projectId, datasetId);

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
      setOpenCaseId(match.id);
      handledCaseParam.current = caseParam;
    }
  }, [searchParams, data]);
  const [reviewCaseId, setReviewCaseId] = React.useState<string | null>(null);
  const [keyword, setKeyword] = React.useState("");
  const [caseDate, setCaseDate] = React.useState<DateFilterOption>(DEFAULT_DATE_FILTER);
  const [caseStart, setCaseStart] = React.useState<Date | null>(null);
  const [caseEnd, setCaseEnd] = React.useState<Date | null>(null);
  const [historyKeyword, setHistoryKeyword] = React.useState("");
  const [historyDate, setHistoryDate] = React.useState<DateFilterOption>(DEFAULT_DATE_FILTER);
  const [historyStart, setHistoryStart] = React.useState<Date | null>(null);
  const [historyEnd, setHistoryEnd] = React.useState<Date | null>(null);
  const [runOpen, setRunOpen] = React.useState(false);
  const [importOpen, setImportOpen] = React.useState(false);
  const [codeOpen, setCodeOpen] = React.useState(false);

  const dataset = data?.dataset ?? null;
  const versions = React.useMemo(() => data?.versions ?? [], [data]);
  const selectedVersion = data?.selectedVersion ?? null;
  const isCurrentVersion = data?.isCurrentVersion ?? true;
  const allCases = React.useMemo(() => data?.testCases ?? [], [data]);

  const cases = React.useMemo(() => {
    const q = keyword.trim().toLowerCase();
    if (!q) return allCases;
    return allCases.filter(
      (c) => c.input.toLowerCase().includes(q) || (c.expected ?? "").toLowerCase().includes(q),
    );
  }, [allCases, keyword]);

  const caseIds = React.useMemo(() => cases.map((c) => c.id), [cases]);
  const sel = useRowSelection(caseIds);

  // All datasets in the project, for the breadcrumb's dataset switcher.
  const { data: allDatasetsData } = useDatasets(projectId, { limit: 200 });
  const allDatasets = React.useMemo(() => allDatasetsData?.data ?? [], [allDatasetsData]);

  const evaluations = useEvaluationRuns(projectId, { dataset_id: datasetId });
  const runs = React.useMemo(() => evaluations.data?.data ?? [], [evaluations.data]);
  const visibleRuns = React.useMemo(() => {
    const q = historyKeyword.trim().toLowerCase();
    if (!q) return runs;
    return runs.filter(
      (r) =>
        r.evaluationName.toLowerCase().includes(q) ||
        (r.mainScoreName ?? "").toLowerCase().includes(q),
    );
  }, [runs, historyKeyword]);

  const openCase = openCaseId ? (cases.find((c) => c.id === openCaseId) ?? null) : null;
  const reviewCase = reviewCaseId ? (cases.find((c) => c.id === reviewCaseId) ?? null) : null;

  const reviewTarget = React.useMemo<TestCaseReviewTarget | null>(() => {
    if (!reviewCase || !dataset) return null;
    return {
      contextLabel: `${caseDisplayId(reviewCase.testCaseId)} · ${dataset.name}`,
      input: reviewCase.input,
      expected: reviewCase.expected,
      currentReview: reviewCase.review,
    };
  }, [reviewCase, dataset]);

  const submitReview = (result: { review: ReviewStatus; correctedExpected?: string }) => {
    if (!reviewCase) return;
    update.mutate(
      {
        testCaseId: reviewCase.testCaseId,
        patch: {
          review: result.review,
          ...(result.correctedExpected ? { expected: result.correctedExpected } : {}),
        },
      },
      {
        onSuccess: () =>
          toast({ title: "Review saved — new dataset version published", tone: "success" }),
      },
    );
    setReviewCaseId(null);
  };

  const addEmptyRow = () => {
    save.mutate(
      { input: "", review: "needs_review", capture_reason: "manual" },
      { onSuccess: () => toast({ title: "Empty row added", tone: "success" }) },
    );
  };

  const duplicateSelected = () => {
    const chosen = cases.filter((c) => sel.has(c.id));
    if (chosen.length === 0) return;
    Promise.all(
      chosen.map((c) =>
        save.mutateAsync({
          input: c.input,
          expected: c.expected,
          metadata: asRecord(c.metadata),
          capture_reason: "manual",
        }),
      ),
    )
      .then(() => toast({ title: `Duplicated ${chosen.length}`, tone: "success" }))
      .catch((e) =>
        toast({ title: "Could not duplicate", description: String(e), tone: "warning" }),
      );
    sel.clear();
  };

  const addSelectedToDataset = () => {
    if (sel.count === 0) return;
    // Cross-dataset copy needs a target picker that isn't wired yet.
    toast({ title: "Add to another dataset — coming soon", tone: "success" });
    sel.clear();
  };

  const deleteSelected = () => {
    if (sel.count === 0) return;
    // Removing a case republishes the version without it — not wired yet, so the
    // action stays honest rather than pretending rows were removed.
    toast({ title: "Deleting cases — coming soon", tone: "success" });
    sel.clear();
  };

  if (isLoading) {
    return (
      <>
        <ProjectBreadcrumb projectId={projectId} current="Datasets" />
        <div className="flex h-64 items-center justify-center text-[13px] text-muted-foreground">
          Loading dataset...
        </div>
      </>
    );
  }
  if (error || !dataset || !data) {
    return (
      <>
        <ProjectBreadcrumb projectId={projectId} current="Datasets" />
        <div className="flex h-full flex-col text-[13px]">
          <EvalPageHeader title="Dataset not found" />
          <EvalBody>
            <EmptyState>
              No dataset with the id {datasetId}.{" "}
              <Link
                href={`/projects/${projectId}/datasets`}
                className="underline underline-offset-2"
              >
                Back to datasets
              </Link>
            </EmptyState>
          </EvalBody>
        </div>
      </>
    );
  }

  return (
    <>
      <ProjectBreadcrumb
        projectId={projectId}
        trail={[
          {
            // Just the dataset segment (no separate "Datasets" crumb) — a dropdown
            // of all datasets, like the project segment. Its menu header still links
            // to the Datasets list, so that page stays one click away.
            label: dataset.name,
            menuHeader: { label: "Datasets", href: `/projects/${projectId}/datasets` },
            options: allDatasets.map((d) => ({
              id: d.id,
              label: d.name,
              href: `/projects/${projectId}/datasets/${d.id}`,
              isCurrent: d.id === dataset.id,
            })),
          },
        ]}
      />
      <div className="flex h-full flex-col text-[13px]">
        <EvalPageHeader
          title={
            <span className="flex flex-wrap items-center gap-2">
              <span>{dataset.name}</span>
              <span className="font-mono text-xs font-normal text-muted-foreground">
                {dataset.id}
              </span>
              <CopyButton
                value={dataset.id}
                className="h-6 w-6 text-muted-foreground hover:text-foreground"
                title="Copy dataset ID"
              />
            </span>
          }
          action={
            <Button size="sm" className="h-7 gap-1.5 text-[12px]" onClick={() => setRunOpen(true)}>
              <Play className="h-3.5 w-3.5" aria-hidden />
              Run evaluation
            </Button>
          }
        />

        {/* Version bar — pick a snapshot to view (previous versions are read-only),
            with its immutable version id + copy. */}
        <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border px-4 py-1.5 text-[12px]">
          <span className="text-muted-foreground">Version</span>
          <Select value={selectedVersion?.id ?? ""} onValueChange={(v) => setSelectedVersionId(v)}>
            <SelectTrigger className="h-7 w-[240px] text-[12px]">
              <SelectValue placeholder="Current version" />
            </SelectTrigger>
            <SelectContent>
              {versions.map((v) => (
                <SelectItem key={v.id} value={v.id} className="text-[12px]">
                  v{v.versionNumber}
                  {v.id === dataset.currentVersionId ? " (current)" : ""}
                  {v.label ? ` · ${v.label}` : ""}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {selectedVersion && (
            <>
              <span className="font-mono text-[11px] text-muted-foreground">
                {selectedVersion.id}
              </span>
              <CopyButton
                value={selectedVersion.id}
                className="h-6 w-6 text-muted-foreground hover:text-foreground"
                title="Copy version ID"
              />
            </>
          )}
          {!isCurrentVersion && (
            <span className="ml-auto rounded border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-[11px] text-amber-700 dark:text-amber-300">
              Viewing an older version — read only
            </span>
          )}
        </div>

        <Tabs defaultValue="cases" className="flex min-h-0 flex-1 flex-col">
          <TabsList className="shrink-0 px-4 pt-2" aria-label="Dataset views">
            <TabsTrigger value="cases" count={cases.length}>
              Test cases
            </TabsTrigger>
            <TabsTrigger value="history" count={runs.length}>
              Evaluation history
            </TabsTrigger>
          </TabsList>

          <TabsContent value="cases" className="flex min-h-0 flex-1 flex-col">
            {/* Toolbar — the standard SearchFilterBar (search + actions + date). */}
            <SearchFilterBar
              searchValue={keyword}
              onSearchChange={setKeyword}
              searchPlaceholder="Search cases..."
              dateFilter={caseDate}
              customStartDate={caseStart}
              customEndDate={caseEnd}
              onDateFilterChange={setCaseDate}
              onCustomRangeChange={(s, e) => {
                setCaseStart(s);
                setCaseEnd(e);
              }}
            >
              <Button
                variant="outline"
                size="sm"
                className="h-7 gap-1.5 text-[12px]"
                onClick={() => setImportOpen(true)}
                // Editing branches from the current version, so it's disabled while
                // viewing an older snapshot.
                disabled={!isCurrentVersion}
              >
                <Upload className="h-3.5 w-3.5" aria-hidden />
                Import
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="h-7 gap-1.5 text-[12px]"
                onClick={addEmptyRow}
                disabled={save.isPending || !isCurrentVersion}
              >
                <Plus className="h-3.5 w-3.5" aria-hidden />
                Row
              </Button>

              {/* Selection actions appear beside the editing actions when rows are selected. */}
              {sel.count > 0 && (
                <span className="flex items-center gap-1.5">
                  <button
                    type="button"
                    onClick={sel.clear}
                    aria-label="Cancel selection"
                    className="rounded p-0.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                  >
                    <X className="h-3.5 w-3.5" aria-hidden />
                  </button>
                  <span className="text-[12px] font-medium tabular-nums">{sel.count} selected</span>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 gap-1 px-1.5 text-[12px] text-muted-foreground hover:text-foreground"
                    onClick={duplicateSelected}
                  >
                    <Copy className="h-3.5 w-3.5" aria-hidden />
                    Duplicate
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 gap-1 px-1.5 text-[12px] text-muted-foreground hover:text-foreground"
                    onClick={addSelectedToDataset}
                  >
                    <Plus className="h-3.5 w-3.5" aria-hidden />
                    Add to dataset
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 gap-1 px-1.5 text-[12px] text-destructive hover:bg-destructive/10 hover:text-destructive"
                    onClick={deleteSelected}
                  >
                    <Trash2 className="h-3.5 w-3.5" aria-hidden />
                    Delete
                  </Button>
                  <span className="h-4 w-px bg-border" aria-hidden />
                </span>
              )}

              {/* Spacer keeps the dataset-level actions flush against the date filter. */}
              <span className="flex-1" aria-hidden />

              {/* Dataset-level actions (no dropdown). */}
              <span className="flex items-center gap-1">
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 gap-1.5 px-1.5 text-[12px] text-muted-foreground hover:text-foreground"
                  onClick={() => toast({ title: "Export — coming soon", tone: "success" })}
                >
                  <Download className="h-3.5 w-3.5" aria-hidden />
                  Download
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 gap-1.5 px-1.5 text-[12px] text-muted-foreground hover:text-foreground"
                  onClick={() => {
                    navigator.clipboard?.writeText(dataset.id);
                    toast({ title: "Dataset ID copied", tone: "success" });
                  }}
                >
                  <Copy className="h-3.5 w-3.5" aria-hidden />
                  Copy ID
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 gap-1.5 px-1.5 text-[12px] text-muted-foreground hover:text-foreground"
                  onClick={() => setCodeOpen(true)}
                >
                  <FileCode className="h-3.5 w-3.5" aria-hidden />
                  Pull code
                </Button>
              </span>
            </SearchFilterBar>

            {/* Table + focused-case slide-in panel */}
            <div className="min-h-0 flex-1 overflow-auto">
              {cases.length === 0 ? (
                <EmptyState>
                  {keyword
                    ? "No cases match your search."
                    : "No test cases yet — use Row to add one, or open a trace, select the root or a span, and save it as a test case."}
                </EmptyState>
              ) : (
                <Table>
                  <THead>
                    <TRHead>
                      <SelectAllHeaderCell
                        checked={sel.allSelected}
                        indeterminate={sel.someSelected}
                        onToggle={sel.toggleAll}
                      />
                      <Th className="w-[150px]">Created</Th>
                      <Th>Input</Th>
                      <Th>Expected</Th>
                      <Th>Metadata</Th>
                    </TRHead>
                  </THead>
                  <TBody>
                    {cases.map((tc) => (
                      <TR
                        key={tc.id}
                        interactive
                        selected={tc.id === openCaseId}
                        onClick={() => setOpenCaseId(tc.id)}
                      >
                        <SelectRowCell
                          checked={sel.has(tc.id)}
                          onToggle={() => sel.toggle(tc.id)}
                          label={`Select ${tc.testCaseId}`}
                        />
                        <Td className="whitespace-nowrap text-muted-foreground">
                          <Timestamp iso={tc.createTime} />
                        </Td>
                        <Td>{orDash(truncate(tc.input, 60) || null)}</Td>
                        <Td>{orDash(tc.expected)}</Td>
                        <Td>{metadataPreview(tc.metadata)}</Td>
                      </TR>
                    ))}
                  </TBody>
                </Table>
              )}
            </div>
          </TabsContent>

          <TabsContent value="history" className="flex min-h-0 flex-1 flex-col">
            <SearchFilterBar
              searchValue={historyKeyword}
              onSearchChange={setHistoryKeyword}
              searchPlaceholder="Search evaluations..."
              dateFilter={historyDate}
              customStartDate={historyStart}
              customEndDate={historyEnd}
              onDateFilterChange={setHistoryDate}
              onCustomRangeChange={(s, e) => {
                setHistoryStart(s);
                setHistoryEnd(e);
              }}
            />
            <EvalBody>
              {visibleRuns.length === 0 ? (
                <EmptyState>
                  {historyKeyword
                    ? "No evaluations match your search."
                    : `Nothing has been run against ${dataset.name} yet.`}
                </EmptyState>
              ) : (
                <Table>
                  <THead>
                    <TRHead>
                      <Th className="w-[170px]">Ran at</Th>
                      <Th>Evaluation</Th>
                      <Th>Main score</Th>
                      <Th className="text-right">Score</Th>
                    </TRHead>
                  </THead>
                  <TBody>
                    {visibleRuns.map((run) => (
                      <TR
                        key={run.id}
                        interactive
                        onClick={() => router.push(`/projects/${projectId}/evaluations/${run.id}`)}
                      >
                        <Td className="whitespace-nowrap text-muted-foreground">
                          <Timestamp iso={run.startedAt} />
                        </Td>
                        <Td className="font-medium">{run.evaluationName}</Td>
                        <Td className="text-muted-foreground">{run.mainScoreName ?? "—"}</Td>
                        <Td className="text-right tabular-nums">
                          {run.mainScore === null ? (
                            <span className="text-muted-foreground">—</span>
                          ) : (
                            pct(run.mainScore)
                          )}
                        </Td>
                      </TR>
                    ))}
                  </TBody>
                </Table>
              )}
            </EvalBody>
          </TabsContent>
        </Tabs>
      </div>

      {/* Focused case — slides in from the right like a trace. */}
      {openCase && (
        <CasePanel
          testCase={openCase}
          projectId={projectId}
          datasetId={datasetId}
          readOnly={!isCurrentVersion}
          onClose={() => setOpenCaseId(null)}
          onReview={() => setReviewCaseId(openCase.id)}
          onNavigate={(dir) => {
            const idx = cases.findIndex((c) => c.id === openCase.id);
            const next = dir === "up" ? idx - 1 : idx + 1;
            if (next >= 0 && next < cases.length) setOpenCaseId(cases[next].id);
          }}
          canNavigateUp={cases.findIndex((c) => c.id === openCase.id) > 0}
          canNavigateDown={cases.findIndex((c) => c.id === openCase.id) < cases.length - 1}
        />
      )}

      {/* Import — centered island. */}
      <Dialog open={importOpen} onOpenChange={setImportOpen}>
        <DialogContent className="max-w-[520px]">
          <DialogHeader>
            <DialogTitle className="text-[13px] font-medium">Import test cases</DialogTitle>
          </DialogHeader>
          <UploadControl
            onFile={(fileName) =>
              toast({
                title: "File selected — import coming soon",
                description: `${fileName} would be imported.`,
                tone: "success",
              })
            }
          />
          <p className="text-[11px] text-muted-foreground">
            CSV or JSON. Bulk import isn&apos;t wired yet — add cases with Row, or save a span from
            a trace.
          </p>
        </DialogContent>
      </Dialog>

      {/* Pull code — a right-side slide-out, like the Run-evaluation starter code. */}
      <DatasetPullCodeDrawer
        datasetId={dataset.id}
        datasetName={dataset.name}
        open={codeOpen}
        onOpenChange={setCodeOpen}
      />

      {/* Launched from a dataset, so the snippet is prefilled with it. */}
      <RunEvaluationDrawer
        projectId={projectId}
        open={runOpen}
        onOpenChange={setRunOpen}
        datasetId={datasetId}
      />

      <TestCaseReviewDrawer
        target={reviewTarget}
        open={reviewCaseId !== null}
        onOpenChange={(open) => !open && setReviewCaseId(null)}
        onSubmit={submitReview}
      />
    </>
  );
}

/**
 * Slide-in case panel, matching the trace/span detail panel: a header with an
 * icon, the row id, a copy button and the up/down/fullscreen/open-in-new-tab/
 * close controls; then the created date; then Source / Captured chips (in place
 * of a span kind). Input, expected, and metadata render as editable value
 * blocks; saving any edit publishes a new immutable dataset version.
 */
function CasePanel({
  testCase,
  projectId,
  datasetId,
  readOnly = false,
  onClose,
  onReview,
  onNavigate,
  canNavigateUp,
  canNavigateDown,
}: {
  testCase: TestCaseRow;
  projectId: string;
  datasetId: string;
  /** Viewing an older snapshot: fields and Save are disabled (editing branches
   * from the current version, not this one). */
  readOnly?: boolean;
  onClose: () => void;
  onReview: () => void;
  onNavigate: (direction: "up" | "down") => void;
  canNavigateUp: boolean;
  canNavigateDown: boolean;
}) {
  const { toast } = useToast();
  const { sidebarCollapsed } = useLayout();
  const update = useUpdateTestCase(projectId, datasetId);
  const caseRuns = useTestCaseRuns(projectId, datasetId, testCase.testCaseId);
  const runs = caseRuns.data?.data ?? [];
  const [fullscreen, setFullscreen] = React.useState(false);
  const [view, setView] = React.useState<"details" | "runs">("details");

  // Editable buffers, seeded from the case and re-seeded when it changes.
  // Input/expected are plain strings; metadata is edited as JSON and parsed back.
  const initialMetadata = React.useMemo(() => {
    const record = asRecord(testCase.metadata);
    return Object.keys(record).length ? JSON.stringify(record, null, 2) : "";
  }, [testCase.metadata]);
  const [inputText, setInputText] = React.useState(testCase.input);
  const [expectedText, setExpectedText] = React.useState(testCase.expected ?? "");
  const [metadataText, setMetadataText] = React.useState(initialMetadata);

  React.useEffect(() => {
    setInputText(testCase.input);
    setExpectedText(testCase.expected ?? "");
    setMetadataText(initialMetadata);
  }, [testCase.id, testCase.input, testCase.expected, initialMetadata]);

  const dirty =
    !readOnly &&
    (inputText !== testCase.input ||
      expectedText !== (testCase.expected ?? "") ||
      metadataText !== initialMetadata);

  // Metadata only persists when it parses to an object; a half-typed edit keeps
  // the prior value rather than blowing it away.
  const parseMetadata = (): Record<string, unknown> | null | undefined => {
    if (metadataText.trim() === "") return null;
    try {
      const parsed = JSON.parse(metadataText);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      /* invalid JSON mid-edit */
    }
    return undefined; // leave stored metadata untouched
  };

  const saveEdits = () => {
    const patch: {
      input?: string;
      expected?: string | null;
      metadata?: Record<string, unknown> | null;
    } = {};
    if (inputText !== testCase.input) patch.input = inputText;
    if (expectedText !== (testCase.expected ?? "")) {
      patch.expected = expectedText.trim() === "" ? null : expectedText;
    }
    if (metadataText !== initialMetadata) {
      const parsed = parseMetadata();
      if (parsed !== undefined) patch.metadata = parsed;
    }
    if (Object.keys(patch).length === 0) return;
    update.mutate(
      { testCaseId: testCase.testCaseId, patch },
      {
        onSuccess: () => toast({ title: "Saved — new dataset version published", tone: "success" }),
      },
    );
  };

  return (
    <div
      className={cn(
        "animate-slide-in-right fixed bottom-0 right-0 z-50 flex flex-col border-l border-border bg-background shadow-xl transition-[width,top] duration-200",
        fullscreen
          ? sidebarCollapsed
            ? "top-14 w-[calc(100%-3.5rem)]"
            : "top-14 w-[calc(100%-12rem)]"
          : "top-0 w-[45%] min-w-[520px] max-w-[94vw]",
      )}
    >
      {/* Header — same shape as the trace/span detail panel. */}
      <div className="shrink-0 border-b border-border bg-muted/30 px-4 py-3">
        <div className="flex items-start justify-between gap-2">
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

        <Timestamp iso={testCase.createTime} className="mt-1 block text-xs text-muted-foreground" />

        <div className="mt-2 flex flex-wrap items-center gap-2">
          <ReviewBadge status={testCase.review} />
          {testCase.sourceTraceId ? (
            <Link
              href={`/projects/${projectId}/traces?traceId=${testCase.sourceTraceId}&fullscreen=1`}
              className="inline-flex items-center gap-1.5 rounded-md border bg-muted/40 py-1 pl-2.5 pr-1.5 text-xs transition-colors hover:bg-muted"
            >
              <span className="text-muted-foreground">Source:</span>
              <SpanKindIcon kind={(testCase.sourceSpanKind ?? "SPAN") as never} />
              <span className="font-medium">{testCase.sourceSpanName ?? "trace"}</span>
              <ChevronRight className="h-3 w-3 text-muted-foreground" />
            </Link>
          ) : (
            <span className="inline-flex items-center gap-1.5 rounded-md border bg-muted/40 px-2.5 py-1 text-xs">
              <span className="text-muted-foreground">Source:</span>
              <span className="font-medium">Added manually</span>
            </span>
          )}
          {/* Why this case was captured — read-only context. */}
          <span className="inline-flex items-center gap-1.5 rounded-md border bg-muted/40 px-2.5 py-1 text-xs">
            <span className="text-muted-foreground">Captured:</span>
            <span className="font-medium">
              {CAPTURE_REASON_LABEL[testCase.captureReason as keyof typeof CAPTURE_REASON_LABEL] ??
                testCase.captureReason}
            </span>
          </span>
        </div>
      </div>

      {/* View toggle — Details / Runs, where a trace shows Tree / Timeline. */}
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
          <FileText className="h-3.5 w-3.5" /> Details
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
          <History className="h-3.5 w-3.5" /> Runs
          {runs.length > 0 && (
            <span className="rounded bg-muted px-1 text-[10px] tabular-nums text-muted-foreground">
              {runs.length}
            </span>
          )}
        </button>
      </div>

      {view === "details" ? (
        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4 text-[12px]">
          <EditableValueBlock
            key={`input-${testCase.id}`}
            label="Input"
            text={inputText}
            onChange={setInputText}
            copyable
            autoDetectKind
            boxed
            minRows={2}
            readOnly={readOnly}
          />
          <EditableValueBlock
            key={`expected-${testCase.id}`}
            label="Expected"
            text={expectedText}
            onChange={setExpectedText}
            copyable
            autoDetectKind
            boxed
            minRows={2}
            readOnly={readOnly}
          />
          {/* Recorded production output — read-only, kept separate from Expected. */}
          {testCase.recordedOutput !== null && (
            <EditableValueBlock
              key={`recorded-${testCase.id}`}
              label="What happened in production"
              text={testCase.recordedOutput}
              onChange={() => {}}
              copyable
              autoDetectKind
              boxed
              minRows={2}
              readOnly
            />
          )}
          <EditableValueBlock
            key={`metadata-${testCase.id}`}
            label="Metadata"
            text={metadataText}
            defaultKind="pretty"
            onChange={setMetadataText}
            copyable
            autoDetectKind
            boxed
            minRows={2}
            readOnly={readOnly}
          />
          <p className="text-[11px] leading-snug text-muted-foreground">
            Saving publishes a new dataset version — it changes what future runs are compared
            against and never rewrites a snapshot an earlier run used.
          </p>
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-auto p-4">
          {runs.length === 0 ? (
            <EmptyState>
              No evaluation run has measured this test case yet. Runs appear here once your
              application or CI reports them.
            </EmptyState>
          ) : (
            <Table>
              <THead>
                <TRHead>
                  <Th className="w-[150px]">Ran at</Th>
                  <Th>Candidate version</Th>
                  <Th className="w-[90px] text-right">Score</Th>
                  <Th className="w-[100px]">Change</Th>
                  <Th className="w-[110px]">Status</Th>
                </TRHead>
              </THead>
              <TBody>
                {runs.map((r) => (
                  <TR key={r.resultId}>
                    <Td className="whitespace-nowrap text-muted-foreground">
                      <Timestamp iso={r.ranAt} />
                    </Td>
                    <Td>
                      <Link
                        href={`/projects/${projectId}/evaluations/${r.runId}`}
                        className="rounded font-mono text-[11px] hover:underline focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                      >
                        {r.candidateVersion}
                      </Link>
                      <span className="ml-1.5 text-[11px] text-muted-foreground">
                        {r.evaluationName}
                      </span>
                    </Td>
                    <Td className="text-right tabular-nums">
                      {r.score === null ? (
                        <span className="text-muted-foreground">—</span>
                      ) : (
                        scoreDisplay(r.score)
                      )}
                    </Td>
                    <Td>
                      {r.change === null ? (
                        <span className="text-muted-foreground">—</span>
                      ) : (
                        <span className={SENTIMENT_CLASS[changeSentiment(CHANGE_DELTA[r.change])]}>
                          {r.change}
                        </span>
                      )}
                    </Td>
                    <Td>
                      <EvalResultBadge status={r.status as never} />
                    </Td>
                  </TR>
                ))}
              </TBody>
            </Table>
          )}
        </div>
      )}

      {/* Save (when edited) + Review — primary actions, at the bottom. */}
      <div className="flex shrink-0 items-center gap-2 border-t border-border p-3">
        {dirty && (
          <Button
            size="sm"
            variant="outline"
            className="h-8 flex-1 text-[12px]"
            disabled={update.isPending}
            onClick={saveEdits}
          >
            Save changes
          </Button>
        )}
        <Button size="sm" className="h-8 flex-1 text-[12px]" onClick={onReview}>
          Review
        </Button>
      </div>
    </div>
  );
}
