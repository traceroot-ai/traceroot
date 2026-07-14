"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { FileCode, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { CopyButton } from "@/components/ui/copy-button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Table, TBody, THead, TR, TRHead, Td, Th } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useToast } from "@/components/ui/toast";
import { SearchFilterBar } from "@/components/search-filter-bar";
import { DATE_FILTER_OPTIONS, type DateFilterOption } from "@/lib/date-filter";
import { ProjectBreadcrumb } from "@/features/projects/components";
import {
  EmptyState,
  EvalBody,
  EvalPageHeader,
  Timestamp,
} from "@/features/offline-eval/components";
import { RunStatusBadge, ScoreValue, formatCost, formatElapsed } from "./evaluations-view";
import { PassRate } from "../components/pass-rate";
import { datasetPullCode, datasetPullCodeTs, truncate } from "@/features/offline-eval/utils";
import { useDataset, useSaveTestCase, useEvaluationRuns } from "../hooks";
import { PullCodeDrawer, type PullOption } from "../components/pull-code-drawer";

/** "Last 14 days" default, matching the traces/datasets lists. */
const DEFAULT_DATE_FILTER =
  DATE_FILTER_OPTIONS.find((o) => o.id === "14d") ?? DATE_FILTER_OPTIONS[0];

/** A dash for the list; empty reads as a placeholder, not a blank cell. */
function orDash(value: string | null): React.ReactNode {
  return value && value.trim() !== "" ? value : <span className="text-muted-foreground">-</span>;
}

/** Metadata is stored as unknown JSON; coerce to a flat record for display. */
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
 * Dataset detail — the dataset detail surface, wired to the server.
 *
 * A version bar picks a snapshot to view (older versions are read-only). The
 * test-case table lists Created · Input · Expected · Metadata (empty reads as
 * "-"), and New row adds an empty test case. A second tab lists the evaluation
 * runs measured against this dataset. "Pull code" opens the shared drawer with
 * a snippet that fetches the dataset in code.
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
  // null = the current version. Selecting an older version loads its snapshot
  // (read-only — editing always branches from the current version).
  const [selectedVersionId, setSelectedVersionId] = React.useState<string | null>(null);
  const { data, isLoading, error } = useDataset(projectId, datasetId, selectedVersionId);
  const save = useSaveTestCase(projectId, datasetId);

  const [keyword, setKeyword] = React.useState("");
  const [caseDate, setCaseDate] = React.useState<DateFilterOption>(DEFAULT_DATE_FILTER);
  const [caseStart, setCaseStart] = React.useState<Date | null>(null);
  const [caseEnd, setCaseEnd] = React.useState<Date | null>(null);
  const [historyKeyword, setHistoryKeyword] = React.useState("");
  const [historyDate, setHistoryDate] = React.useState<DateFilterOption>(DEFAULT_DATE_FILTER);
  const [historyStart, setHistoryStart] = React.useState<Date | null>(null);
  const [historyEnd, setHistoryEnd] = React.useState<Date | null>(null);
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

  const addEmptyRow = () => {
    save.mutate(
      { input: "", review: "needs_review", capture_reason: "manual" },
      { onSuccess: () => toast({ title: "Empty row added", tone: "success" }) },
    );
  };

  if (isLoading) {
    return (
      <>
        <ProjectBreadcrumb projectId={projectId} />
        <div className="flex h-64 items-center justify-center text-[13px] text-muted-foreground">
          Loading dataset...
        </div>
      </>
    );
  }
  if (error || !dataset || !data) {
    return (
      <>
        <ProjectBreadcrumb projectId={projectId} />
        <div className="flex h-full flex-col text-[13px]">
          <EvalPageHeader
            parent={{ label: "Datasets", href: `/projects/${projectId}/datasets` }}
            title="Dataset not found"
          />
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
      <ProjectBreadcrumb projectId={projectId} />
      <div className="flex h-full flex-col text-[13px]">
        <EvalPageHeader
          parent={{ label: "Datasets", href: `/projects/${projectId}/datasets` }}
          title={
            <span className="flex flex-wrap items-center gap-2">
              <span>{dataset.name}</span>
              <span className="font-mono text-xs font-normal text-muted-foreground">
                {dataset.id}
              </span>
            </span>
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
                onClick={addEmptyRow}
                disabled={save.isPending || !isCurrentVersion}
              >
                <Plus className="h-3.5 w-3.5" aria-hidden />
                Row
              </Button>

              {/* Spacer keeps the dataset-level actions flush against the date filter. */}
              <span className="flex-1" aria-hidden />

              {/* Dataset-level actions (no dropdown). */}
              <span className="flex items-center gap-1">
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

            {/* Test-case table — read-only rows. */}
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
                      <Th className="w-[150px]">Created</Th>
                      <Th>Input</Th>
                      <Th>Expected</Th>
                      <Th>Metadata</Th>
                    </TRHead>
                  </THead>
                  <TBody>
                    {cases.map((tc) => (
                      <TR key={tc.id}>
                        <Td className="whitespace-nowrap text-muted-foreground">
                          <Timestamp iso={tc.createTime} />
                        </Td>
                        <Td className="max-w-[320px] truncate" title={tc.input || undefined}>
                          {orDash(tc.input || null)}
                        </Td>
                        <Td className="max-w-[320px] truncate" title={tc.expected ?? undefined}>
                          {orDash(tc.expected)}
                        </Td>
                        <Td className="max-w-[240px] truncate">{metadataPreview(tc.metadata)}</Td>
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
                      <Th>Evaluation / Run</Th>
                      <Th>Dataset</Th>
                      <Th className="w-[110px] text-right">Main score</Th>
                      <Th className="w-[100px] text-right">Passed</Th>
                      <Th className="w-[100px] text-right">Cost</Th>
                      <Th className="w-[90px] text-right">Duration</Th>
                      <Th className="w-[150px]">Status</Th>
                      <Th className="w-[130px] text-right">Timestamp</Th>
                    </TRHead>
                  </THead>
                  <TBody>
                    {visibleRuns.map((run) => (
                      <TR
                        key={run.id}
                        interactive
                        onClick={() => router.push(`/projects/${projectId}/evaluations/${run.id}`)}
                      >
                        <Td>
                          <div className="font-medium">{run.evaluationName}</div>
                          <div className="text-[11px] text-muted-foreground">
                            Run #{run.runNumber} ·{" "}
                            <span className="font-mono">{run.candidateVersion}</span>
                          </div>
                        </Td>
                        <Td className="text-muted-foreground">
                          <div>{run.datasetName}</div>
                          <div className="text-[11px]">{run.datasetVersionLabel}</div>
                        </Td>
                        <Td className="text-right tabular-nums">
                          <ScoreValue value={run.mainScore} />
                        </Td>
                        <Td className="text-right tabular-nums">
                          <PassRate counts={run} />
                        </Td>
                        <Td className="text-right tabular-nums text-muted-foreground">
                          {formatCost(run.cost)}
                        </Td>
                        <Td className="whitespace-nowrap text-right tabular-nums text-muted-foreground">
                          {formatElapsed(run.elapsedMs)}
                        </Td>
                        <Td>
                          <RunStatusBadge status={run.status} />
                        </Td>
                        <Td className="whitespace-nowrap text-right text-muted-foreground">
                          <Timestamp iso={run.startedAt} />
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

      {/* Pull code — the shared drawer: one snippet that fetches the dataset. */}
      <PullCodeDrawer
        title="Pull this dataset in code"
        subtitle={
          <>
            Fetch <span className="font-medium text-foreground">{dataset.name}</span> to run an
            evaluation against. Only the dataset is pullable — an evaluation or run id isn&apos;t.
          </>
        }
        options={
          [
            {
              id: "latest",
              label: "Pull dataset",
              note: "Fetches the dataset's current published version when the run starts.",
              py: datasetPullCode(dataset.id),
              ts: datasetPullCodeTs(dataset.id),
            },
          ] satisfies PullOption[]
        }
        open={codeOpen}
        onOpenChange={setCodeOpen}
      />
    </>
  );
}
