"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { ArrowRight, Info } from "lucide-react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Table, TBody, THead, TR, TRHead, Td, Th } from "@/components/ui/table";
import { EmptyState, Timestamp } from "@/features/offline-eval/components";
import {
  changeSentiment,
  pctFraction,
  SENTIMENT_CLASS,
  signedPoints,
} from "@/features/offline-eval/utils";
import { useCompareRuns, useEvaluationRuns, useEvaluations } from "../hooks";
import type { CompareRunSummary, RunComparison, Classification } from "../types";
import { RunStatusBadge } from "./evaluations-view";

const ALL = "";

const REASON_LABEL: Record<string, string> = {
  no_baseline: "No baseline chosen.",
  baseline_missing: "The baseline run wasn't found.",
  different_evaluation: "These runs are from different evaluations.",
  different_dataset_version: "The runs used different dataset versions — cases may not line up.",
  baseline_not_terminal: "The baseline run hasn't finished.",
};

const CHANGE_LABEL: Record<Classification, { label: string; className: string }> = {
  improved: { label: "Improved", className: SENTIMENT_CLASS.good },
  regressed: { label: "Regressed", className: SENTIMENT_CLASS.bad },
  unchanged: { label: "Unchanged", className: "text-muted-foreground" },
  changed: { label: "Changed", className: "text-foreground" },
  unpaired: { label: "Unpaired", className: "text-muted-foreground" },
  not_comparable: { label: "Not comparable", className: "text-amber-600 dark:text-amber-400" },
};

function fmtScore(v: number | null): string {
  return v === null ? "—" : pctFraction(v);
}

/** One run's picker (candidate / baseline), listing the evaluation's runs newest-first. */
function RunPicker({
  label,
  runs,
  value,
  onChange,
  disabledId,
}: {
  label: string;
  runs: Array<{ id: string; runNumber: number; candidateVersion: string }>;
  value: string;
  onChange: (id: string) => void;
  disabledId?: string;
}) {
  return (
    <div className="flex items-center gap-1.5">
      <span className="text-[11px] text-muted-foreground">{label}</span>
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger className="h-7 w-[220px] text-[12px]">
          <SelectValue placeholder="Select a run" />
        </SelectTrigger>
        <SelectContent>
          {runs.map((r) => (
            <SelectItem
              key={r.id}
              value={r.id}
              className="text-[12px]"
              disabled={r.id === disabledId}
            >
              Run #{r.runNumber} · {r.candidateVersion}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

/** Candidate | Baseline | Δ summary row (higher-is-better metrics like the main score). */
function StatRow({
  label,
  candidate,
  baseline,
  delta,
  format,
  higherIsBetter = true,
}: {
  label: string;
  candidate: number | null;
  baseline: number | null;
  delta: number | null;
  format: (n: number) => string;
  higherIsBetter?: boolean;
}) {
  return (
    <tr>
      <td className="py-1 pr-2 text-muted-foreground">{label}</td>
      <td className="py-1 text-right tabular-nums">
        {candidate === null ? "—" : format(candidate)}
      </td>
      <td className="py-1 text-right tabular-nums text-muted-foreground">
        {baseline === null ? "—" : format(baseline)}
      </td>
      <td className="py-1 pl-2 pr-2.5 text-right tabular-nums">
        {delta === null || delta === 0 ? (
          <span className="text-muted-foreground">{delta === 0 ? "±0" : "—"}</span>
        ) : (
          <span className={SENTIMENT_CLASS[changeSentiment(higherIsBetter ? delta : -delta)]}>
            {delta > 0 ? "+" : "−"}
            {format(Math.abs(delta))}
          </span>
        )}
      </td>
    </tr>
  );
}

function RunHeaderCard({ run, role }: { run: CompareRunSummary; role: "Candidate" | "Baseline" }) {
  return (
    <div className="min-w-0 flex-1 rounded border border-border bg-muted/20 px-3 py-2">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[11px] uppercase tracking-wide text-muted-foreground">{role}</span>
        <RunStatusBadge status={run.status} />
      </div>
      <div className="mt-1 flex items-baseline gap-1.5">
        <span className="text-[13px] font-semibold">Run #{run.runNumber}</span>
        <span className="truncate font-mono text-[11px] text-muted-foreground">
          {run.candidateVersion}
        </span>
      </div>
      <div className="mt-0.5 text-[11px] text-muted-foreground">
        {run.datasetVersionLabel} · <Timestamp iso={run.startedAt} />
      </div>
    </div>
  );
}

function fmtMs(n: number): string {
  return n < 1000 ? `${Math.round(n)}ms` : `${(n / 1000).toFixed(1)}s`;
}

function SummaryTable({ comparison }: { comparison: RunComparison }) {
  const c = comparison;
  return (
    <div className="overflow-hidden rounded border border-border">
      <table className="w-full text-[12px]">
        <thead>
          <tr className="text-[10px] text-muted-foreground">
            <th className="py-1 pl-2.5 text-left font-normal"></th>
            <th className="py-1 text-right font-normal">Candidate</th>
            <th className="py-1 text-right font-normal">Baseline</th>
            <th className="py-1 pr-2.5 text-right font-normal">Δ</th>
          </tr>
        </thead>
        <tbody className="[&_td:first-child]:pl-2.5">
          <StatRow
            label="Main score"
            candidate={c.mainScore.candidate}
            baseline={c.mainScore.baseline}
            delta={c.mainScore.delta}
            format={(n) => pctFraction(n)}
          />
          {c.scorers.map((s) => (
            <StatRow
              key={`${s.name}@${s.version}`}
              label={`${s.name}`}
              candidate={s.candidateMean}
              baseline={s.baselineMean}
              delta={s.delta}
              format={(n) => pctFraction(n)}
              higherIsBetter={s.direction !== "lower_is_better"}
            />
          ))}
          <StatRow
            label="Avg case duration"
            candidate={c.duration.candidateMeanMs}
            baseline={c.duration.baselineMeanMs}
            delta={c.duration.deltaMs}
            format={fmtMs}
            higherIsBetter={false}
          />
        </tbody>
      </table>
      <div className="flex flex-wrap gap-x-4 gap-y-0.5 border-t border-border px-2.5 py-1.5 text-[11px] text-muted-foreground">
        <span>
          <span className={SENTIMENT_CLASS.good}>{c.caseCounts.improved} improved</span> ·{" "}
          <span className={SENTIMENT_CLASS.bad}>{c.caseCounts.regressed} regressed</span> ·{" "}
          {c.caseCounts.unchanged} unchanged
        </span>
        {(c.caseCounts.unpaired > 0 || c.caseCounts.not_comparable > 0) && (
          <span>
            {c.caseCounts.unpaired} unpaired · {c.caseCounts.not_comparable} not comparable
          </span>
        )}
      </div>
    </div>
  );
}

export function CompareTab({ projectId }: { projectId: string }) {
  const router = useRouter();
  const { data: evalData } = useEvaluations(projectId);
  const evaluations = React.useMemo(() => evalData?.data ?? [], [evalData]);

  const [evaluationId, setEvaluationId] = React.useState<string>(ALL);
  const [candidateId, setCandidateId] = React.useState<string>("");
  const [baselineId, setBaselineId] = React.useState<string>("");

  const { data: runsData } = useEvaluationRuns(
    projectId,
    evaluationId ? { evaluation_id: evaluationId } : undefined,
  );
  const runs = React.useMemo(() => runsData?.data ?? [], [runsData]);

  // Seed the evaluation to the first one, and the pickers to the two newest runs.
  React.useEffect(() => {
    if (!evaluationId && evaluations.length > 0) setEvaluationId(evaluations[0].id);
  }, [evaluations, evaluationId]);
  React.useEffect(() => {
    setCandidateId(runs[0]?.id ?? "");
    setBaselineId(runs[1]?.id ?? "");
  }, [runs]);

  const compare = useCompareRuns(projectId, candidateId || null, baselineId || null);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-wrap items-center gap-3 border-b border-border px-3 py-2">
        <Select
          value={evaluationId}
          onValueChange={(v) => {
            setEvaluationId(v);
            setCandidateId("");
            setBaselineId("");
          }}
        >
          <SelectTrigger className="h-7 w-[200px] text-[12px]">
            <SelectValue placeholder="Evaluation" />
          </SelectTrigger>
          <SelectContent>
            {evaluations.map((e) => (
              <SelectItem key={e.id} value={e.id} className="text-[12px]">
                {e.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <RunPicker
          label="Candidate"
          runs={runs}
          value={candidateId}
          onChange={setCandidateId}
          disabledId={baselineId}
        />
        <ArrowRight className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />
        <RunPicker
          label="Baseline"
          runs={runs}
          value={baselineId}
          onChange={setBaselineId}
          disabledId={candidateId}
        />
      </div>

      <div className="min-h-0 flex-1 space-y-3 overflow-auto p-3 text-[12px]">
        {runs.length < 2 ? (
          <EmptyState>This evaluation needs at least two runs to compare.</EmptyState>
        ) : !candidateId || !baselineId ? (
          <EmptyState>Pick a candidate and a baseline run.</EmptyState>
        ) : compare.isLoading ? (
          <EmptyState>Comparing…</EmptyState>
        ) : compare.error || !compare.data ? (
          <EmptyState>Couldn’t compare these runs.</EmptyState>
        ) : (
          <>
            <div className="flex items-stretch gap-2">
              <RunHeaderCard run={compare.data.candidate} role="Candidate" />
              <RunHeaderCard run={compare.data.baseline} role="Baseline" />
            </div>

            {!compare.data.comparison.trustworthy && (
              <div className="flex items-start gap-1.5 rounded border border-amber-500/40 bg-amber-500/10 px-2.5 py-1.5 text-[11px] text-amber-700 dark:text-amber-300">
                <Info className="mt-0.5 h-3 w-3 shrink-0" aria-hidden />
                <span>
                  {compare.data.comparison.reasons.map((r) => REASON_LABEL[r] ?? r).join(" ")}{" "}
                  Deltas are shown but may not be meaningful.
                </span>
              </div>
            )}

            <SummaryTable comparison={compare.data.comparison} />

            <div className="overflow-hidden rounded border border-border">
              <Table>
                <THead>
                  <TRHead>
                    <Th>Test case</Th>
                    <Th className="w-[110px] text-right">Candidate</Th>
                    <Th className="w-[110px] text-right">Baseline</Th>
                    <Th className="w-[120px]">Change</Th>
                  </TRHead>
                </THead>
                <TBody>
                  {compare.data.results.map((r) => {
                    const cmp = r.comparison;
                    const change = cmp?.caseChange ?? null;
                    return (
                      <TR
                        key={r.testCaseId}
                        interactive={!!r.traceId}
                        onClick={() =>
                          r.traceId &&
                          router.push(
                            `/projects/${projectId}/evaluations/${candidateId}?result=${r.testCaseId}`,
                          )
                        }
                      >
                        <Td className="font-mono text-[11px]">{r.testCaseId}</Td>
                        <Td className="text-right tabular-nums">
                          {fmtScore(cmp?.mainScore.candidate ?? null)}
                        </Td>
                        <Td className="text-right tabular-nums text-muted-foreground">
                          {fmtScore(cmp?.mainScore.baseline ?? null)}
                        </Td>
                        <Td>
                          {change ? (
                            <span className={CHANGE_LABEL[change].className}>
                              {CHANGE_LABEL[change].label}
                              {cmp && cmp.mainScore.delta !== null && cmp.mainScore.delta !== 0 && (
                                <span className="ml-1 text-[11px]">
                                  ({signedPoints(cmp.mainScore.delta)} pp)
                                </span>
                              )}
                            </span>
                          ) : (
                            <span className="text-muted-foreground">—</span>
                          )}
                        </Td>
                      </TR>
                    );
                  })}
                </TBody>
              </Table>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
