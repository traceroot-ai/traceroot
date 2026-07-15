"use client";

import * as React from "react";
import Link from "next/link";
import { ArrowLeft, ChevronDown, Database, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Table, TBody, THead, TR, TRHead, Td, Th } from "@/components/ui/table";
import { ProjectBreadcrumb } from "@/features/projects/components";
import { ReviewBadge, Timestamp, EditableValueBlock } from "@/features/offline-eval/components";
import { cn } from "@/lib/utils";
import { useDataset, useUpdateTestCase } from "../hooks";
import type { TestCaseRow } from "../types";

function truncate(s: string, n = 70) {
  return s.length <= n ? s : `${s.slice(0, n - 1)}…`;
}

/** Real, server-backed dataset detail: current version's test cases + versions. */
export function DatasetDetailView({
  projectId,
  datasetId,
}: {
  projectId: string;
  datasetId: string;
}) {
  const { data, isLoading, error } = useDataset(projectId, datasetId);
  const [openCaseId, setOpenCaseId] = React.useState<string | null>(null);

  const testCases = data?.testCases ?? [];
  const openCase = openCaseId ? (testCases.find((t) => t.id === openCaseId) ?? null) : null;

  return (
    <>
      <ProjectBreadcrumb projectId={projectId} current="Datasets" />
      <div className="flex flex-1 flex-col overflow-hidden text-[13px]">
        {isLoading ? (
          <div className="flex h-64 items-center justify-center">
            <p className="text-[13px] text-muted-foreground">Loading dataset...</p>
          </div>
        ) : error || !data ? (
          <div className="flex h-64 flex-col items-center justify-center gap-2">
            <p className="text-[13px] text-destructive">Dataset not found</p>
            <Link
              href={`/projects/${projectId}/datasets`}
              className="text-[12px] text-muted-foreground underline"
            >
              Back to datasets
            </Link>
          </div>
        ) : (
          <>
            <div className="flex items-center justify-between gap-2 border-b border-border px-4 py-2">
              <div className="flex min-w-0 items-center gap-2">
                <Link
                  href={`/projects/${projectId}/datasets`}
                  className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
                  title="Back to datasets"
                >
                  <ArrowLeft className="h-4 w-4" />
                </Link>
                <Database className="h-4 w-4 shrink-0 text-muted-foreground" />
                <h1 className="truncate text-[13px] font-medium">{data.dataset.name}</h1>
                {data.currentVersion && (
                  <VersionPicker
                    label={data.currentVersion.label}
                    versions={data.versions}
                    isCurrent={(id) => id === data.dataset.currentVersionId}
                  />
                )}
                <span className="text-[12px] text-muted-foreground">
                  {data.versions.length} {data.versions.length === 1 ? "version" : "versions"}
                </span>
              </div>
            </div>

            <div className="min-h-0 flex-1 overflow-auto">
              {testCases.length === 0 ? (
                <div className="flex h-64 flex-col items-center justify-center gap-2">
                  <p className="text-[13px] text-muted-foreground">No test cases yet</p>
                  <p className="text-[12px] text-muted-foreground">
                    Open a trace, select the root or a span, and save it as a test case.
                  </p>
                </div>
              ) : (
                <Table>
                  <THead>
                    <TRHead>
                      <Th className="w-[160px]">Created</Th>
                      <Th>Input</Th>
                      <Th>Expected</Th>
                      <Th className="w-[130px]">Review</Th>
                      <Th>Source span</Th>
                    </TRHead>
                  </THead>
                  <TBody>
                    {testCases.map((tc) => (
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
                            <span>
                              {tc.sourceSpanName}
                              {tc.sourceSpanKind ? (
                                <span className="ml-1 text-[11px]">({tc.sourceSpanKind})</span>
                              ) : null}
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
          </>
        )}
      </div>

      {openCase && (
        <CasePanel
          projectId={projectId}
          datasetId={datasetId}
          testCase={openCase}
          onClose={() => setOpenCaseId(null)}
        />
      )}
    </>
  );
}

function VersionPicker({
  label,
  versions,
  isCurrent,
}: {
  label: string;
  versions: { id: string; label: string; versionNumber: number; createTime: string }[];
  isCurrent: (id: string) => boolean;
}) {
  const [open, setOpen] = React.useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button className="inline-flex items-center gap-1 rounded border border-border px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground hover:bg-muted hover:text-foreground">
          {label}
          <ChevronDown className="h-3 w-3" aria-hidden />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="max-h-[300px] w-56 overflow-y-auto p-1">
        <p className="px-2 py-1 text-[10px] uppercase tracking-wide text-muted-foreground">
          Immutable snapshots
        </p>
        {versions.map((v) => (
          <div
            key={v.id}
            className={cn(
              "flex items-center justify-between rounded px-2 py-1 text-[12px]",
              isCurrent(v.id) ? "bg-muted/70" : "",
            )}
          >
            <span>
              {v.label}
              {isCurrent(v.id) && (
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

/** Slide-in panel for one test case. Editing Expected publishes a new version. */
function CasePanel({
  projectId,
  datasetId,
  testCase,
  onClose,
}: {
  projectId: string;
  datasetId: string;
  testCase: TestCaseRow;
  onClose: () => void;
}) {
  const [expected, setExpected] = React.useState(testCase.expected ?? "");
  const update = useUpdateTestCase(projectId, datasetId);

  React.useEffect(() => {
    setExpected(testCase.expected ?? "");
  }, [testCase.id, testCase.expected]);

  const dirty = expected.trim() !== (testCase.expected ?? "").trim();
  const metadataText =
    testCase.metadata && typeof testCase.metadata === "object"
      ? JSON.stringify(testCase.metadata, null, 2)
      : "";

  const saveExpected = () => {
    update.mutate({
      testCaseId: testCase.testCaseId,
      patch: { expected: expected.trim() === "" ? null : expected.trim() },
    });
  };

  return (
    <div className="animate-slide-in-right fixed inset-y-0 right-0 z-50 flex w-[45%] min-w-[520px] max-w-[94vw] flex-col border-l border-border bg-background shadow-xl">
      <div className="flex shrink-0 items-center justify-between border-b border-border bg-muted/30 px-4 py-3">
        <div className="flex min-w-0 items-center gap-2">
          <span className="text-sm font-medium">Test case</span>
          <span className="truncate font-mono text-xs text-muted-foreground">
            {testCase.testCaseId}
          </span>
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

      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-4 text-[12px]">
        {testCase.sourceTraceId && (
          <Link
            href={`/projects/${projectId}/traces?traceId=${testCase.sourceTraceId}&fullscreen=1`}
            className="inline-flex w-fit items-center gap-1.5 rounded-md border bg-muted/40 px-2.5 py-1 text-xs transition-colors hover:bg-muted"
          >
            <span className="text-muted-foreground">Source:</span>
            <span className="font-medium">{testCase.sourceSpanName ?? "trace"}</span>
            {testCase.sourceSpanKind && (
              <span className="text-muted-foreground">({testCase.sourceSpanKind})</span>
            )}
          </Link>
        )}

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

        {metadataText && (
          <EditableValueBlock
            label="Metadata"
            text={metadataText}
            onChange={() => {}}
            defaultKind="json"
            boxed
            minRows={2}
            readOnly
          />
        )}
      </div>
    </div>
  );
}
