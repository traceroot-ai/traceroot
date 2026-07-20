"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { ArrowLeftRight, ArrowRight, Info } from "lucide-react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Table, TBody, THead, TR, TRHead, Td, Th } from "@/components/ui/table";
import { EmptyState, Timestamp } from "@/features/offline-eval/components";
import { ProjectBreadcrumb } from "@/features/projects/components";
import {
  changeSentiment,
  pctFraction,
  SENTIMENT_CLASS,
  signedPoints,
} from "@/features/offline-eval/utils";
import { useCompareRuns, useEvaluationRuns, useEvaluations } from "../hooks";
import type { CompareRunSummary, RunComparison, Classification } from "../types";
import { RunStatusBadge } from "./evaluations-view";

/** Reasons that make a comparison's deltas untrustworthy. `different_evaluation` is
 *  intentionally NOT here — cross-evaluation comparison is allowed and merely labeled;
 *  what disables trusted deltas is a dataset-version mismatch, a non-terminal baseline,
 *  a missing baseline, or an incompatible main scorer. */
const BLOCKING_REASONS = new Set([
  "different_dataset_version",
  "baseline_not_terminal",
  "baseline_missing",
  "no_baseline",
  "main_scorer_incompatible",
]);

const REASON_LABEL: Record<string, string> = {
  no_baseline: "No baseline chosen.",
  baseline_missing: "The baseline run wasn't found.",
  different_evaluation: "These runs are from different evaluations.",
  different_dataset_version:
    "The runs used different immutable dataset versions — their cases don't line up.",
  baseline_not_terminal: "The baseline run hasn't finished.",
  main_scorer_incompatible:
    "The main scorer's name/version differs, so no comparable pair exists — trusted deltas are disabled.",
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
function fmtMs(n: number): string {
  return n < 1000 ? `${Math.round(n)}ms` : `${(n / 1000).toFixed(1)}s`;
}

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

function RunHeaderCard({
  run,
  role,
  crossEval,
}: {
  run: CompareRunSummary;
  role: "Candidate" | "Baseline";
  crossEval: boolean;
}) {
  return (
    <div className="min-w-0 flex-1 rounded border border-border bg-muted/20 px-3 py-2">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[11px] uppercase tracking-wide text-muted-foreground">{role}</span>
        <RunStatusBadge status={run.status} />
      </div>
      {/* In a cross-evaluation comparison both evaluation names are shown prominently. */}
      {crossEval && <div className="mt-1 text-[12px] font-medium">{run.evaluationName}</div>}
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
              label={s.name}
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

/** An evaluation + run picker for one side (candidate or baseline). Supports picking a
 *  run from ANY evaluation, so a cross-evaluation pair can be assembled here too. */
function RunChooser({
  projectId,
  label,
  seedEvaluationId,
  runId,
  otherRunId,
  onPick,
}: {
  projectId: string;
  label: string;
  seedEvaluationId: string | null;
  runId: string | null;
  otherRunId: string | null;
  onPick: (runId: string) => void;
}) {
  const { data: evalData } = useEvaluations(projectId);
  const evaluations = React.useMemo(() => evalData?.data ?? [], [evalData]);
  const [evalId, setEvalId] = React.useState<string>(seedEvaluationId ?? "");
  React.useEffect(() => {
    if (seedEvaluationId) setEvalId(seedEvaluationId);
  }, [seedEvaluationId]);
  const { data: runsData } = useEvaluationRuns(
    projectId,
    evalId ? { evaluation_id: evalId } : undefined,
  );
  const runs = React.useMemo(() => runsData?.data ?? [], [runsData]);

  return (
    <div className="flex items-center gap-1.5">
      <span className="text-[11px] text-muted-foreground">{label}</span>
      <Select value={evalId} onValueChange={setEvalId}>
        <SelectTrigger className="h-7 w-[170px] text-[12px]">
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
      <Select value={runId ?? ""} onValueChange={onPick}>
        <SelectTrigger className="h-7 w-[200px] text-[12px]">
          <SelectValue placeholder="Run" />
        </SelectTrigger>
        <SelectContent>
          {runs.map((r) => (
            <SelectItem
              key={r.id}
              value={r.id}
              className="text-[12px]"
              disabled={r.id === otherRunId}
            >
              Run #{r.runNumber} · {r.candidateVersion}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

/**
 * The shareable comparison view: `?baseline=&candidate=` in the URL. Baseline and
 * candidate roles are explicit and swappable. Reuses the server-derived comparison
 * engine (via the compare route) — no comparison logic here. Cross-evaluation pairs
 * are allowed and clearly labeled; trusted deltas are disabled (with the exact reason)
 * only for a genuine incompatibility, never merely because the evaluations differ.
 */
export function CompareRunsView({
  projectId,
  candidateId,
  baselineId,
  onChange,
}: {
  projectId: string;
  candidateId: string | null;
  baselineId: string | null;
  onChange: (baseline: string | null, candidate: string | null) => void;
}) {
  const router = useRouter();
  const compare = useCompareRuns(projectId, candidateId, baselineId);
  const data = compare.data;

  const candEval = data?.candidate.evaluationId ?? null;
  const baseEval = data?.baseline.evaluationId ?? null;
  const crossEval = !!data && candEval !== baseEval;
  const blocking = (data?.comparison.reasons ?? []).filter((r) => BLOCKING_REASONS.has(r));
  const deltasTrusted = !!data?.comparison.available && blocking.length === 0;

  return (
    <div className="flex h-full flex-col text-[12px]">
      <ProjectBreadcrumb projectId={projectId} current="Compare runs" />

      <div className="flex flex-wrap items-center gap-3 border-b border-border px-3 py-2">
        <RunChooser
          projectId={projectId}
          label="Candidate"
          seedEvaluationId={candEval}
          runId={candidateId}
          otherRunId={baselineId}
          onPick={(id) => onChange(baselineId, id)}
        />
        <Button
          variant="outline"
          size="sm"
          className="h-7 gap-1.5 text-[12px]"
          disabled={!candidateId || !baselineId}
          onClick={() => onChange(candidateId, baselineId)}
          title="Swap baseline and candidate"
        >
          <ArrowLeftRight className="h-3.5 w-3.5" aria-hidden />
          Swap
        </Button>
        <RunChooser
          projectId={projectId}
          label="Baseline"
          seedEvaluationId={baseEval}
          runId={baselineId}
          otherRunId={candidateId}
          onPick={(id) => onChange(id, candidateId)}
        />
      </div>

      <div className="min-h-0 flex-1 space-y-3 overflow-auto p-3">
        {!candidateId || !baselineId ? (
          <EmptyState>Pick a candidate and a baseline run to compare.</EmptyState>
        ) : candidateId === baselineId ? (
          <EmptyState>Pick two different runs.</EmptyState>
        ) : compare.isLoading ? (
          <EmptyState>Comparing…</EmptyState>
        ) : compare.error || !data ? (
          <EmptyState>Couldn’t compare these runs.</EmptyState>
        ) : (
          <>
            <div className="flex items-stretch gap-2">
              <RunHeaderCard run={data.candidate} role="Candidate" crossEval={crossEval} />
              <ArrowRight className="mt-6 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
              <RunHeaderCard run={data.baseline} role="Baseline" crossEval={crossEval} />
            </div>

            {crossEval && (
              <div className="flex items-start gap-1.5 rounded border border-border bg-muted/30 px-2.5 py-1.5 text-[11px]">
                <Info className="mt-0.5 h-3 w-3 shrink-0 text-muted-foreground" aria-hidden />
                <span>
                  <span className="font-medium">Cross-evaluation comparison</span> —{" "}
                  {data.candidate.evaluationName} vs {data.baseline.evaluationName}. No baseline
                  relationship is saved.
                </span>
              </div>
            )}

            {!deltasTrusted && blocking.length > 0 && (
              <div className="flex items-start gap-1.5 rounded border border-amber-500/40 bg-amber-500/10 px-2.5 py-1.5 text-[11px] text-amber-700 dark:text-amber-300">
                <Info className="mt-0.5 h-3 w-3 shrink-0" aria-hidden />
                <span>{blocking.map((r) => REASON_LABEL[r] ?? r).join(" ")}</span>
              </div>
            )}

            <SummaryTable comparison={data.comparison} />

            <div className="overflow-hidden rounded border border-border">
              <Table>
                <THead>
                  <TRHead>
                    <Th>Test case</Th>
                    <Th className="w-[110px] text-right">Candidate</Th>
                    <Th className="w-[110px] text-right">Baseline</Th>
                    <Th className="w-[130px]">Change</Th>
                  </TRHead>
                </THead>
                <TBody>
                  {data.results.map((r) => {
                    const cmp = r.comparison;
                    const change = cmp?.caseChange ?? null;
                    return (
                      <TR
                        key={r.testCaseId}
                        interactive={!!r.candidateTraceId}
                        onClick={() =>
                          r.candidateTraceId &&
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
