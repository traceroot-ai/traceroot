"use client";

import * as React from "react";
import { X, Copy, ArrowRight } from "lucide-react";
import { CopyButton } from "@/components/ui/copy-button";
import { cn } from "@/lib/utils";
import { changeSentiment, SENTIMENT_CLASS } from "@/features/offline-eval/utils";
import { TraceIOSection } from "@/features/traces/components/TraceIOValue";
import { TraceIODiffSection } from "@/features/traces/components/TraceIODiff";
import { useTrace } from "@/features/traces/hooks";
import { attributeTraceUsage, type TraceUsage, type UsageSpan } from "@/lib/eval/trace-usage";
import type {
  CompareResultRow,
  CompareRunSummary,
  CompareRawScore,
  ScorerCellComparison,
} from "../types";

/** A scorer value rendered by its real type — numeric / boolean / categorical. */
function scorerValueText(v: number | boolean | string | null): string {
  if (v === null) return "—";
  if (typeof v === "boolean") return v ? "Pass" : "Fail";
  if (typeof v === "number") return Number.isInteger(v) ? String(v) : v.toFixed(3);
  return v;
}

function fmtMs(ms: number | null): string {
  if (ms === null) return "Unknown";
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
}
function fmtCost(c: number | null): string {
  return c === null ? "Unknown" : `$${c.toFixed(4)}`;
}

/** One scorer row in the breakdown: baseline → candidate with typed transition + explanations. */
function ScorerBreakdownRow({
  cell,
  candidateExplanation,
  baselineExplanation,
}: {
  cell: ScorerCellComparison;
  candidateExplanation: string | null;
  baselineExplanation: string | null;
}) {
  const dirBetter = cell.direction !== "lower_is_better";
  const deltaClass =
    cell.delta === null || cell.delta === 0
      ? "text-muted-foreground"
      : SENTIMENT_CLASS[changeSentiment(dirBetter ? cell.delta : -cell.delta)];
  return (
    <div className="rounded border border-border px-2.5 py-2">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <span className="flex items-baseline gap-1.5">
          <span className="font-medium">{cell.scorerName}</span>
          <span className="text-[11px] text-muted-foreground">{cell.scorerVersion}</span>
          {cell.direction && cell.direction !== "none" && (
            <span className="text-[10px] text-muted-foreground">
              {cell.direction === "higher_is_better" ? "↑ better" : "↓ better"}
            </span>
          )}
        </span>
        <span className="flex items-center gap-1.5 tabular-nums">
          <span className="text-muted-foreground">{scorerValueText(cell.baselineValue)}</span>
          <ArrowRight className="h-3 w-3 text-muted-foreground" aria-hidden />
          <span className="font-medium">{scorerValueText(cell.candidateValue)}</span>
          {cell.transition ? (
            <span className={cn("text-[11px]", deltaClass)}>{cell.classification}</span>
          ) : cell.delta !== null && cell.delta !== 0 ? (
            <span className={cn("text-[11px]", deltaClass)}>
              {cell.delta > 0 ? "+" : "−"}
              {Math.abs(cell.delta).toFixed(cell.valueType === "numeric" ? 3 : 0)}
            </span>
          ) : (
            <span className="text-[11px] text-muted-foreground">{cell.classification}</span>
          )}
        </span>
      </div>
      {(baselineExplanation || candidateExplanation) && (
        <div className="mt-1.5 grid grid-cols-2 gap-2 text-[11px] text-muted-foreground">
          <div>
            <div className="text-[9px] uppercase tracking-wide">Baseline</div>
            <div className="leading-relaxed">{baselineExplanation ?? "—"}</div>
          </div>
          <div>
            <div className="text-[9px] uppercase tracking-wide">Candidate</div>
            <div className="leading-relaxed">{candidateExplanation ?? "—"}</div>
          </div>
        </div>
      )}
      {cell.reason && (
        <div className="mt-1 text-[11px] text-amber-700 dark:text-amber-300">
          {cell.reason.replace(/_/g, " ")}
        </div>
      )}
    </div>
  );
}

function explanationOf(scores: CompareRawScore[], name: string, version: string): string | null {
  const s = scores.find((x) => x.scorerName === name && x.scorerVersion === version);
  return s?.error ?? s?.explanation ?? null;
}

function OpMetric({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 py-0.5">
      <span className="text-[11px] text-muted-foreground">{label}</span>
      <span className="text-[12px] tabular-nums">{value}</span>
    </div>
  );
}

/** Trace-derived tokens for one side (task + scorer + combined), with pending/unknown. */
function useUsage(projectId: string, traceId: string | null): TraceUsage {
  const q = useTrace(projectId, traceId ?? "", !!traceId);
  return React.useMemo(
    () => attributeTraceUsage(q.data?.spans as UsageSpan[] | undefined),
    [q.data],
  );
}

function tokenText(u: TraceUsage): string {
  if (u.state === "pending") return "Pending";
  if (u.state === "unknown") return "Unknown";
  return u.combined.totalTokens.toLocaleString("en-US");
}

/**
 * Selected-case diagnosis drawer: context, Baseline|Candidate outputs, per-scorer
 * breakdown with explanations, operational metrics (duration server-derived; cost
 * stored; tokens trace-derived with pending/unknown), and trace access. Reuses the
 * standard right-side drawer chrome and the trace value/diff renderers.
 */
export function CompareCaseDrawer({
  projectId,
  row,
  candidate,
  baseline,
  onClose,
  traceSlot,
  enabled = true,
}: {
  projectId: string;
  row: CompareResultRow;
  candidate: CompareRunSummary;
  baseline: CompareRunSummary;
  onClose: () => void;
  /** Trace-access controls (candidate/baseline), wired by the page. */
  traceSlot?: React.ReactNode;
  /**
   * Set to false while a non-nested overlay stacked above the drawer (e.g. the trace
   * viewer opened via traceSlot) should own Escape instead of the drawer.
   */
  enabled?: boolean;
}) {
  // Close on Escape. Listen on `document` in the bubble phase — the convention used by
  // TraceViewerPanel — and bail if the key was already consumed by a nested overlay
  // (Radix select/popover), signaled via `defaultPrevented`; call preventDefault() here
  // so any layer further out also knows Escape was handled. `enabled` additionally lets
  // the page suppress this while a sibling overlay (not a descendant, so it can't rely on
  // defaultPrevented) is stacked on top and should own Escape instead.
  React.useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (e.defaultPrevented) return;
      e.preventDefault();
      onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose, enabled]);

  const candUsage = useUsage(projectId, row.candidateTraceId);
  const baseUsage = useUsage(projectId, row.baselineTraceId);
  const cells = row.comparison?.scorerCells ?? [];
  const outputSame = row.outputChanged === false;

  return (
    <div
      id="compare-case-drawer"
      className="animate-slide-in-right fixed inset-y-0 right-0 z-50 flex w-[620px] max-w-[96vw] flex-col border-l border-border bg-background text-[12px] shadow-xl"
    >
      <div className="flex shrink-0 items-start justify-between gap-2 border-b border-border px-4 py-3">
        <div className="min-w-0">
          <div className="text-[13px] font-medium">Case comparison</div>
          <div className="mt-0.5 flex items-center gap-1.5 font-mono text-[11px] text-muted-foreground">
            <span className="truncate">{row.testCaseId}</span>
            <CopyButton
              value={row.testCaseId}
              className="h-4 w-4 text-muted-foreground hover:text-foreground"
              iconClassName="h-3 w-3"
              title="Copy test-case id"
            />
          </div>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="rounded-sm text-muted-foreground hover:text-foreground"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      <div className="min-h-0 flex-1 space-y-3 overflow-auto p-4">
        {/* Context */}
        <TraceIOSection title="Input" content={row.input} defaultOpen />
        {row.expectedOutput && (
          <TraceIOSection title="Expected output" content={row.expectedOutput} />
        )}
        {row.provenance && (
          <div className="flex items-center gap-1.5 rounded border border-border bg-muted/20 px-2.5 py-1.5 text-[11px] text-muted-foreground">
            <Copy className="h-3 w-3 shrink-0" aria-hidden />
            Saved from a production trace ({row.provenance.captureReason})
            {row.provenance.sourceSpanName && ` · ${row.provenance.sourceSpanName}`}
          </div>
        )}
        {!row.inputMatchesDataset && (
          <div className="rounded border border-amber-500/40 bg-amber-500/10 px-2.5 py-1.5 text-[11px] text-amber-700 dark:text-amber-300">
            A run recorded a different input than the pinned dataset case; showing the dataset
            input.
          </div>
        )}

        {/* Baseline → Candidate output */}
        <div>
          <div className="mb-1 text-[11px] uppercase tracking-wide text-muted-foreground">
            Baseline → Candidate output
          </div>
          {outputSame ? (
            <div className="rounded border border-border px-2.5 py-2 text-[11px] text-muted-foreground">
              No output change.
            </div>
          ) : (
            <TraceIODiffSection
              title="Output"
              baseline={row.baselineOutput}
              candidate={row.candidateOutput}
            />
          )}
          {row.candidateTaskError && (
            <div className="mt-1.5 rounded border border-red-300 bg-red-50 px-2.5 py-1.5 text-[11px] text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300">
              Candidate task error — {row.candidateTaskError}
            </div>
          )}
          {row.baselineTaskError && (
            <div className="mt-1.5 rounded border border-red-300 bg-red-50 px-2.5 py-1.5 text-[11px] text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300">
              Baseline task error — {row.baselineTaskError}
            </div>
          )}
        </div>

        {/* Score breakdown */}
        {cells.length > 0 && (
          <div>
            <div className="mb-1 text-[11px] uppercase tracking-wide text-muted-foreground">
              Scorers (baseline → candidate)
            </div>
            <div className="space-y-1.5">
              {cells.map((cell) => (
                <ScorerBreakdownRow
                  key={`${cell.scorerName}@${cell.scorerVersion}`}
                  cell={cell}
                  candidateExplanation={explanationOf(
                    row.candidateScores,
                    cell.scorerName,
                    cell.scorerVersion,
                  )}
                  baselineExplanation={explanationOf(
                    row.baselineScores,
                    cell.scorerName,
                    cell.scorerVersion,
                  )}
                />
              ))}
            </div>
          </div>
        )}

        {/* Operational metrics */}
        <div className="rounded border border-border px-2.5 py-2">
          <div className="mb-1 text-[11px] uppercase tracking-wide text-muted-foreground">
            Operational (baseline → candidate)
          </div>
          <OpMetric
            label="Case duration"
            value={
              <span>
                {fmtMs(row.comparison?.baselineDurationMs ?? null)} →{" "}
                {fmtMs(row.comparison?.durationMs ?? null)}
              </span>
            }
          />
          <OpMetric
            label="Cost"
            value={
              <span>
                {fmtCost(row.baselineCost)} → {fmtCost(row.candidateCost)}
              </span>
            }
          />
          <OpMetric
            label="Tokens (trace)"
            value={
              <span>
                {tokenText(baseUsage)} → {tokenText(candUsage)}
              </span>
            }
          />
        </div>

        {/* Trace access (wired by the page) */}
        {traceSlot && (
          <div className="rounded border border-border px-2.5 py-2">
            <div className="mb-1.5 text-[11px] uppercase tracking-wide text-muted-foreground">
              Traces
            </div>
            {traceSlot}
          </div>
        )}
      </div>

      <div className="flex shrink-0 items-center justify-between gap-2 border-t border-border px-4 py-2 text-[11px] text-muted-foreground">
        <span>
          Baseline Run #{baseline.runNumber} · {baseline.candidateVersion}
        </span>
        <ArrowRight className="h-3 w-3" aria-hidden />
        <span>
          Candidate Run #{candidate.runNumber} · {candidate.candidateVersion}
        </span>
      </div>
    </div>
  );
}
