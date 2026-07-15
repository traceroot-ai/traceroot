"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { FlaskConical, ListChecks } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Table, TBody, THead, TR, TRHead, Td, Th } from "@/components/ui/table";
import { ProjectBreadcrumb } from "@/features/projects/components";
import { Timestamp } from "@/features/offline-eval/components";
import { cn } from "@/lib/utils";
import { useDatasets, useEvaluationRuns, useEvaluations } from "../hooks";
import { EVAL_RUN_STATUS_LABEL, type EvalRunStatus } from "../types";

const STATUS_VARIANT: Record<EvalRunStatus, "success" | "danger" | "warning" | "default"> = {
  running: "default",
  completed: "success",
  completed_with_errors: "warning",
  failed: "danger",
  incomplete: "warning",
};

export function RunStatusBadge({ status }: { status: EvalRunStatus }) {
  return <Badge variant={STATUS_VARIANT[status]}>{EVAL_RUN_STATUS_LABEL[status]}</Badge>;
}

const ALL = "__all__";
type Tab = "runs" | "evaluations";

/** Real, server-backed Evaluations page: runs (executions) + grouped lineages. */
export function EvaluationsView({ projectId }: { projectId: string }) {
  const [tab, setTab] = React.useState<Tab>("runs");
  const [runOpen, setRunOpen] = React.useState(false);

  return (
    <>
      <ProjectBreadcrumb projectId={projectId} current="Evaluations" />
      <div className="flex flex-1 flex-col overflow-hidden text-[13px]">
        <div className="flex items-center justify-between border-b border-border bg-background pr-3">
          <div className="flex">
            {(
              [
                { id: "runs", label: "Runs", icon: ListChecks },
                { id: "evaluations", label: "Evaluations", icon: FlaskConical },
              ] as const
            ).map((t) => {
              const Icon = t.icon;
              const active = t.id === tab;
              return (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => setTab(t.id)}
                  className={cn(
                    "flex items-center gap-1.5 border-b-2 px-3 py-1.5 text-[13px] font-medium transition-colors",
                    active
                      ? "border-foreground bg-muted text-foreground"
                      : "border-transparent text-muted-foreground hover:text-foreground",
                  )}
                >
                  <Icon className="h-3.5 w-3.5" />
                  {t.label}
                </button>
              );
            })}
          </div>
          <Button size="sm" className="h-7 text-[12px]" onClick={() => setRunOpen(true)}>
            Run evaluation
          </Button>
        </div>

        {tab === "runs" ? <RunsTab projectId={projectId} /> : <LineagesTab projectId={projectId} />}
      </div>

      <RunEvaluationDialog open={runOpen} onOpenChange={setRunOpen} />
    </>
  );
}

function RunsTab({ projectId }: { projectId: string }) {
  const router = useRouter();
  const [keyword, setKeyword] = React.useState("");
  const [datasetFilter, setDatasetFilter] = React.useState(ALL);
  const [statusFilter, setStatusFilter] = React.useState(ALL);

  const { data: datasetsData } = useDatasets(projectId, { limit: 200 });
  const { data, isLoading, error } = useEvaluationRuns(projectId, {
    search_query: keyword.trim() || undefined,
    dataset_id: datasetFilter === ALL ? undefined : datasetFilter,
    status: statusFilter === ALL ? undefined : statusFilter,
  });
  const runs = data?.data ?? [];

  return (
    <>
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-2">
        <Input
          value={keyword}
          onChange={(e) => setKeyword(e.target.value)}
          placeholder="Search runs..."
          className="h-7 max-w-xs text-[12px]"
        />
        <Select value={datasetFilter} onValueChange={setDatasetFilter}>
          <SelectTrigger className="h-7 w-[170px] text-[12px]">
            <SelectValue placeholder="Dataset" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL} className="text-[12px]">
              All datasets
            </SelectItem>
            {(datasetsData?.data ?? []).map((d) => (
              <SelectItem key={d.id} value={d.id} className="text-[12px]">
                {d.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={statusFilter} onValueChange={setStatusFilter}>
          <SelectTrigger className="h-7 w-[180px] text-[12px]">
            <SelectValue placeholder="Status" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL} className="text-[12px]">
              All statuses
            </SelectItem>
            {(Object.keys(EVAL_RUN_STATUS_LABEL) as EvalRunStatus[]).map((s) => (
              <SelectItem key={s} value={s} className="text-[12px]">
                {EVAL_RUN_STATUS_LABEL[s]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        {isLoading ? (
          <Centered>Loading runs...</Centered>
        ) : error ? (
          <Centered tone="destructive">Error loading runs</Centered>
        ) : runs.length === 0 ? (
          <Centered>
            No evaluation runs yet. Runs appear here once your application or CI reports them via
            the SDK.
          </Centered>
        ) : (
          <Table>
            <THead>
              <TRHead>
                <Th>Name</Th>
                <Th className="w-[150px]">Candidate version</Th>
                <Th>Dataset</Th>
                <Th className="w-[110px] text-right">Main score</Th>
                <Th className="w-[100px] text-right">Change</Th>
                <Th className="w-[170px]">Status</Th>
                <Th className="w-[80px] text-right">Errors</Th>
                <Th className="w-[150px] text-right">Started</Th>
              </TRHead>
            </THead>
            <TBody>
              {runs.map((r) => (
                <TR
                  key={r.id}
                  interactive
                  onClick={() => router.push(`/projects/${projectId}/evaluations/${r.id}`)}
                >
                  <Td className="font-medium">
                    {r.evaluationName}
                    <span className="ml-1.5 font-normal text-muted-foreground">#{r.runNumber}</span>
                  </Td>
                  <Td className="font-mono text-[11px]">{r.candidateVersion}</Td>
                  <Td className="text-muted-foreground">{r.datasetName ?? "—"}</Td>
                  <Td className="text-right tabular-nums">
                    {r.mainScore === null ? (
                      <span className="text-muted-foreground">—</span>
                    ) : (
                      `${r.mainScore.toFixed(1)}%`
                    )}
                  </Td>
                  <Td className="text-right tabular-nums">
                    {r.changeFromBaseline === null ? (
                      <span className="text-muted-foreground">—</span>
                    ) : (
                      <span
                        className={r.changeFromBaseline >= 0 ? "text-emerald-600" : "text-red-600"}
                      >
                        {r.changeFromBaseline >= 0 ? "+" : ""}
                        {r.changeFromBaseline.toFixed(1)} pp
                      </span>
                    )}
                  </Td>
                  <Td>
                    <RunStatusBadge status={r.status} />
                  </Td>
                  <Td className="text-right tabular-nums">
                    {r.errorCount === 0 ? (
                      <span className="text-muted-foreground">—</span>
                    ) : (
                      r.errorCount
                    )}
                  </Td>
                  <Td className="whitespace-nowrap text-right text-muted-foreground">
                    <Timestamp iso={r.startedAt} />
                  </Td>
                </TR>
              ))}
            </TBody>
          </Table>
        )}
      </div>
    </>
  );
}

function LineagesTab({ projectId }: { projectId: string }) {
  const router = useRouter();
  const { data, isLoading, error } = useEvaluations(projectId);
  const evals = data?.data ?? [];

  return (
    <div className="min-h-0 flex-1 overflow-auto">
      {isLoading ? (
        <Centered>Loading evaluations...</Centered>
      ) : error ? (
        <Centered tone="destructive">Error loading evaluations</Centered>
      ) : evals.length === 0 ? (
        <Centered>No evaluations yet.</Centered>
      ) : (
        <Table>
          <THead>
            <TRHead>
              <Th>Evaluation</Th>
              <Th>Dataset</Th>
              <Th className="w-[80px] text-right">Runs</Th>
              <Th className="w-[150px]">Latest candidate</Th>
              <Th className="w-[120px] text-right">Latest score</Th>
              <Th className="w-[150px] text-right">Last run</Th>
            </TRHead>
          </THead>
          <TBody>
            {evals.map((e) => (
              <TR
                key={e.id}
                interactive={!!e.latestRun}
                onClick={() =>
                  e.latestRun && router.push(`/projects/${projectId}/evaluations/${e.latestRun.id}`)
                }
              >
                <Td className="font-medium">{e.name}</Td>
                <Td className="text-muted-foreground">{e.datasetName ?? "—"}</Td>
                <Td className="text-right tabular-nums text-muted-foreground">{e.runCount}</Td>
                <Td className="font-mono text-[11px]">{e.latestRun?.candidateVersion ?? "—"}</Td>
                <Td className="text-right tabular-nums">
                  {e.latestRun?.mainScore == null ? (
                    <span className="text-muted-foreground">—</span>
                  ) : (
                    `${e.latestRun.mainScore.toFixed(1)}%`
                  )}
                </Td>
                <Td className="whitespace-nowrap text-right text-muted-foreground">
                  {e.latestRun ? <Timestamp iso={e.latestRun.startedAt} /> : "—"}
                </Td>
              </TR>
            ))}
          </TBody>
        </Table>
      )}
    </div>
  );
}

function Centered({ children, tone }: { children: React.ReactNode; tone?: "destructive" }) {
  return (
    <div className="flex h-64 items-center justify-center px-6 text-center">
      <p className={cn("text-[13px]", tone ? "text-destructive" : "text-muted-foreground")}>
        {children}
      </p>
    </div>
  );
}

function RunEvaluationDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[480px]">
        <DialogHeader>
          <DialogTitle className="text-[13px] font-medium">Run evaluation</DialogTitle>
        </DialogHeader>
        <p className="text-[12px] leading-relaxed text-muted-foreground">
          Evaluations run in your application or CI environment using the TraceRoot SDK, and report
          their results back here. Nothing runs from the browser. Starter code will be shown here
          once the evaluation SDK is available.
        </p>
        <DialogFooter>
          <Button size="sm" className="h-7 text-[12px]" onClick={() => onOpenChange(false)}>
            Done
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
