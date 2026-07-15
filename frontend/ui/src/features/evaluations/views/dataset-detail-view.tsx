"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ChevronDown, ChevronRight, Copy, Download, FileCode, Play, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { CopyButton } from "@/components/ui/copy-button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Table, TBody, THead, TR, TRHead, Td, Th } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useToast } from "@/components/ui/toast";
import { SearchFilterBar } from "@/components/search-filter-bar";
import { DATE_FILTER_OPTIONS, type DateFilterOption } from "@/lib/date-filter";
import { ProjectBreadcrumb } from "@/features/projects/components";
import { SpanKindIcon } from "@/features/traces";
import { cn } from "@/lib/utils";
import {
  EmptyState,
  EvalPageHeader,
  ReviewBadge,
  EditableValueBlock,
  Timestamp,
} from "@/features/offline-eval/components";
import {
  TestCaseReviewDrawer,
  type TestCaseReviewTarget,
} from "../components/test-case-review-drawer";
import { CAPTURE_REASON_LABEL } from "@/features/offline-eval/types";
import {
  changeSentiment,
  pct,
  SENTIMENT_CLASS,
  signed,
  truncate,
} from "@/features/offline-eval/utils";
import { useDataset, useUpdateTestCase, useEvaluationRuns } from "../hooks";
import type { TestCaseRow, DatasetVersionRow, RunRow } from "../types";
import { RunEvaluationDrawer } from "../components/run-evaluation-drawer";
import { RunStatusBadge } from "./evaluations-view";

const DEFAULT_DATE_FILTER =
  DATE_FILTER_OPTIONS.find((o) => o.id === "14d") ?? DATE_FILTER_OPTIONS[0];

function metadataText(metadata: unknown): string {
  return metadata && typeof metadata === "object" ? JSON.stringify(metadata, null, 2) : "";
}

/**
 * Dataset detail — faithful port of the prototype's dataset detail, wired to the
 * server: an EvalPageHeader with a Run-evaluation action, Test cases / Evaluation
 * history tabs, the immutable version picker, and a slide-in case panel with the
 * Review-test-case flow. Editing a case publishes a new dataset version.
 */
export function DatasetDetailView({
  projectId,
  datasetId,
}: {
  projectId: string;
  datasetId: string;
}) {
  const { toast } = useToast();
  const { data, isLoading, error } = useDataset(projectId, datasetId);

  const [keyword, setKeyword] = React.useState("");
  const [caseDate, setCaseDate] = React.useState<DateFilterOption>(DEFAULT_DATE_FILTER);
  const [caseStart, setCaseStart] = React.useState<Date | null>(null);
  const [caseEnd, setCaseEnd] = React.useState<Date | null>(null);
  const [runOpen, setRunOpen] = React.useState(false);
  const [openCaseId, setOpenCaseId] = React.useState<string | null>(null);
  const [reviewCaseId, setReviewCaseId] = React.useState<string | null>(null);

  const allCases = React.useMemo(() => data?.testCases ?? [], [data]);
  const cases = React.useMemo(() => {
    const q = keyword.trim().toLowerCase();
    if (!q) return allCases;
    return allCases.filter(
      (c) => c.input.toLowerCase().includes(q) || (c.expected ?? "").toLowerCase().includes(q),
    );
  }, [allCases, keyword]);

  const openCase = openCaseId ? (cases.find((c) => c.id === openCaseId) ?? null) : null;
  const reviewCase = reviewCaseId ? (cases.find((c) => c.id === reviewCaseId) ?? null) : null;
  const update = useUpdateTestCase(projectId, datasetId);

  const evaluations = useEvaluationRuns(projectId, { dataset_id: datasetId });
  const runs = evaluations.data?.data ?? [];

  const reviewTarget = React.useMemo<TestCaseReviewTarget | null>(() => {
    if (!reviewCase || !data) return null;
    return {
      contextLabel: `${reviewCase.testCaseId} · ${data.dataset.name}`,
      input: reviewCase.input,
      expected: reviewCase.expected,
      currentReview: reviewCase.review,
    };
  }, [reviewCase, data]);

  const submitReview = (result: {
    review: "needs_review" | "ready";
    correctedExpected?: string;
  }) => {
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
  if (error || !data) {
    return (
      <>
        <ProjectBreadcrumb projectId={projectId} current="Datasets" />
        <div className="flex h-64 flex-col items-center justify-center gap-2 text-[13px]">
          <p className="text-destructive">Dataset not found</p>
          <Link
            href={`/projects/${projectId}/datasets`}
            className="text-[12px] text-muted-foreground underline"
          >
            Back to datasets
          </Link>
        </div>
      </>
    );
  }

  return (
    <>
      <ProjectBreadcrumb projectId={projectId} current="Datasets" />
      <div className="flex h-full flex-col text-[13px]">
        <EvalPageHeader
          title={
            <span className="flex items-center gap-2">
              {data.dataset.name}
              {data.currentVersion && (
                <VersionPicker current={data.currentVersion} versions={data.versions} />
              )}
            </span>
          }
          backHref={`/projects/${projectId}/datasets`}
          backLabel="Datasets"
          action={
            <Button size="sm" className="h-7 gap-1.5 text-[12px]" onClick={() => setRunOpen(true)}>
              <Play className="h-3.5 w-3.5" aria-hidden />
              Run evaluation
            </Button>
          }
        />

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
              <span className="flex-1" aria-hidden />
              <span className="flex items-center gap-1">
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 gap-1.5 px-1.5 text-[12px] text-muted-foreground hover:text-foreground"
                  onClick={() => toast({ title: "Export coming soon", tone: "success" })}
                >
                  <Download className="h-3.5 w-3.5" aria-hidden />
                  Download
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 gap-1.5 px-1.5 text-[12px] text-muted-foreground hover:text-foreground"
                  onClick={() => {
                    navigator.clipboard?.writeText(data.dataset.id);
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
                  onClick={() => setRunOpen(true)}
                >
                  <FileCode className="h-3.5 w-3.5" aria-hidden />
                  Init code
                </Button>
              </span>
            </SearchFilterBar>

            <div className="min-h-0 flex-1 overflow-auto">
              {cases.length === 0 ? (
                <EmptyState>
                  {keyword
                    ? "No cases match your search."
                    : "No test cases yet — open a trace, select the root or a span, and save it as a test case."}
                </EmptyState>
              ) : (
                <Table>
                  <THead>
                    <TRHead>
                      <Th className="w-[150px]">Created</Th>
                      <Th>Input</Th>
                      <Th>Expected</Th>
                      <Th className="w-[120px]">Review</Th>
                      <Th>Source span</Th>
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
                        <Td className="whitespace-nowrap text-muted-foreground">
                          <Timestamp iso={tc.createTime} />
                        </Td>
                        <Td>{truncate(tc.input, 60)}</Td>
                        <Td className="text-muted-foreground">{tc.expected ?? "—"}</Td>
                        <Td>
                          <ReviewBadge status={tc.review} />
                        </Td>
                        <Td className="text-muted-foreground">
                          {tc.sourceSpanName ? (
                            <span className="inline-flex items-center gap-1.5">
                              <SpanKindIcon kind={(tc.sourceSpanKind ?? "SPAN") as never} />
                              {tc.sourceSpanName}
                            </span>
                          ) : (
                            "—"
                          )}
                        </Td>
                      </TR>
                    ))}
                  </TBody>
                </Table>
              )}
            </div>
          </TabsContent>

          <TabsContent value="history" className="flex min-h-0 flex-1 flex-col">
            <div className="min-h-0 flex-1 overflow-auto">
              {runs.length === 0 ? (
                <EmptyState>Nothing has been run against this dataset yet.</EmptyState>
              ) : (
                <Table>
                  <THead>
                    <TRHead>
                      <Th className="w-[170px]">Ran at</Th>
                      <Th>Candidate version</Th>
                      <Th className="w-[110px] text-right">Main score</Th>
                      <Th className="w-[100px] text-right">Change</Th>
                      <Th className="w-[160px]">Status</Th>
                    </TRHead>
                  </THead>
                  <TBody>
                    {runs.map((r) => (
                      <RunHistoryRow key={r.id} projectId={projectId} run={r} />
                    ))}
                  </TBody>
                </Table>
              )}
            </div>
          </TabsContent>
        </Tabs>
      </div>

      {openCase && (
        <CasePanel
          projectId={projectId}
          datasetId={datasetId}
          testCase={openCase}
          onClose={() => setOpenCaseId(null)}
          onReview={() => setReviewCaseId(openCase.id)}
        />
      )}

      <RunEvaluationDrawer
        projectId={projectId}
        open={runOpen}
        onOpenChange={setRunOpen}
        datasetId={datasetId}
      />

      <TestCaseReviewDrawer
        target={reviewTarget}
        open={reviewCaseId !== null}
        onOpenChange={(o) => !o && setReviewCaseId(null)}
        onSubmit={submitReview}
      />
    </>
  );
}

function RunHistoryRow({ projectId, run }: { projectId: string; run: RunRow }) {
  const router = useRouter();
  return (
    <TR interactive onClick={() => router.push(`/projects/${projectId}/evaluations/${run.id}`)}>
      <Td className="whitespace-nowrap text-muted-foreground">
        <Timestamp iso={run.startedAt} />
      </Td>
      <Td className="font-mono text-[11px]">{run.candidateVersion}</Td>
      <Td className="text-right tabular-nums">
        {run.mainScore === null ? "—" : pct(run.mainScore)}
      </Td>
      <Td className="text-right tabular-nums">
        {run.changeFromBaseline === null ? (
          <span className="text-muted-foreground">—</span>
        ) : (
          <span className={SENTIMENT_CLASS[changeSentiment(run.changeFromBaseline)]}>
            {signed(run.changeFromBaseline)} pp
          </span>
        )}
      </Td>
      <Td>
        <RunStatusBadge status={run.status} />
      </Td>
    </TR>
  );
}

function VersionPicker({
  current,
  versions,
}: {
  current: DatasetVersionRow;
  versions: DatasetVersionRow[];
}) {
  const [open, setOpen] = React.useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button className="inline-flex items-center gap-1 rounded border border-border px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground hover:bg-muted hover:text-foreground">
          {current.label}
          <ChevronDown className="h-3 w-3" aria-hidden />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="max-h-[300px] w-64 overflow-y-auto p-1">
        <p className="px-2 py-1 text-[10px] uppercase tracking-wide text-muted-foreground">
          Immutable snapshots
        </p>
        {versions.map((v) => (
          <div
            key={v.id}
            className={cn(
              "flex items-center justify-between rounded px-2 py-1 text-[12px]",
              v.id === current.id ? "bg-muted/70" : "",
            )}
          >
            <span>
              {v.label}
              {v.id === current.id && (
                <span className="ml-1.5 text-[10px] text-muted-foreground">current</span>
              )}
            </span>
            <span className="text-[11px] text-muted-foreground">
              <Timestamp iso={v.createTime} />
            </span>
          </div>
        ))}
      </PopoverContent>
    </Popover>
  );
}

/** Slide-in case panel — matches the prototype's; editing publishes a version. */
function CasePanel({
  projectId,
  datasetId,
  testCase,
  onClose,
  onReview,
}: {
  projectId: string;
  datasetId: string;
  testCase: TestCaseRow;
  onClose: () => void;
  onReview: () => void;
}) {
  const { toast } = useToast();
  const [expected, setExpected] = React.useState(testCase.expected ?? "");
  const update = useUpdateTestCase(projectId, datasetId);

  React.useEffect(() => {
    setExpected(testCase.expected ?? "");
  }, [testCase.id, testCase.expected]);

  const dirty = expected.trim() !== (testCase.expected ?? "").trim();
  const meta = metadataText(testCase.metadata);
  const captureReason =
    CAPTURE_REASON_LABEL[testCase.captureReason as keyof typeof CAPTURE_REASON_LABEL] ??
    testCase.captureReason;

  const saveExpected = () => {
    update.mutate(
      {
        testCaseId: testCase.testCaseId,
        patch: { expected: expected.trim() === "" ? null : expected.trim() },
      },
      {
        onSuccess: () => toast({ title: "Saved — new dataset version published", tone: "success" }),
      },
    );
  };

  return (
    <div className="animate-slide-in-right fixed inset-y-0 right-0 z-50 flex w-[45%] min-w-[520px] max-w-[94vw] flex-col border-l border-border bg-background shadow-xl">
      <div className="shrink-0 border-b border-border bg-muted/30 px-4 py-3">
        <div className="flex items-start justify-between gap-2">
          <div className="flex min-w-0 items-center gap-2">
            <span className="text-sm font-medium">Test case</span>
            <span className="truncate font-mono text-xs text-muted-foreground">
              {testCase.testCaseId}
            </span>
            <CopyButton
              value={testCase.testCaseId}
              className="h-6 w-6 text-muted-foreground hover:text-foreground"
              title="Copy ID"
            />
            <ReviewBadge status={testCase.review} />
          </div>
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

        <div className="mt-2 flex flex-wrap items-center gap-2">
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
          <span className="inline-flex items-center gap-1.5 rounded-md border bg-muted/40 px-2.5 py-1 text-xs">
            <span className="text-muted-foreground">Captured:</span>
            <span className="font-medium">{captureReason}</span>
          </span>
        </div>
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4 text-[12px]">
        <EditableValueBlock
          label="Input"
          text={testCase.input}
          onChange={() => {}}
          boxed
          minRows={2}
          readOnly
        />

        <div>
          <p className="mb-1 text-[11px] text-muted-foreground">Expected outcome</p>
          <div className="flex items-center gap-2">
            <Input
              value={expected}
              onChange={(e) => setExpected(e.target.value)}
              placeholder="No expected outcome — a scorer judges the output directly."
              className="h-7 text-[12px]"
            />
            <Button
              size="sm"
              className="h-7 shrink-0 text-[12px]"
              disabled={!dirty || update.isPending}
              onClick={saveExpected}
            >
              Save
            </Button>
          </div>
          <p className="mt-1 text-[11px] text-muted-foreground">
            Saving publishes a new dataset version — it changes what future runs are compared
            against and never rewrites a snapshot an earlier run used.
          </p>
        </div>

        {testCase.recordedOutput !== null && (
          <EditableValueBlock
            label="What happened in production"
            text={testCase.recordedOutput}
            onChange={() => {}}
            boxed
            minRows={2}
            readOnly
          />
        )}

        {meta && (
          <EditableValueBlock
            label="Metadata"
            text={meta}
            onChange={() => {}}
            defaultKind="json"
            boxed
            minRows={2}
            readOnly
          />
        )}
      </div>

      <div className="shrink-0 border-t border-border p-3">
        <Button size="sm" className="h-8 w-full text-[12px]" onClick={onReview}>
          Review test case
        </Button>
      </div>
    </div>
  );
}
