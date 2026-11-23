"use client";

import * as React from "react";
import type { TraceUsage } from "@/lib/eval/trace-usage";

/**
 * Per-RESULT usage, split into the candidate's own execution and the evaluation
 * (judge) overhead — the same distinction the compare drawer makes, brought to
 * single-run result inspection. The two are NEVER combined into one candidate cost;
 * a combined figure, if shown, is labelled "Total including evaluation".
 *
 * Every number is trace-derived per result (reliable), so this lives in the result
 * drawer rather than as a run-level aggregate. Identities are kept distinct: the
 * OBSERVED task model (task subtree) is the candidate; the judge model (scorer
 * subtree) is the evaluator and is never shown as the model being evaluated. Missing
 * data stays pending/unknown — never coerced to zero.
 */
export function ResultUsageSummary({
  usage,
  durationMs,
  taskCost,
  executionLabel = "Candidate execution",
  formatDuration = defaultDuration,
  formatCost = defaultCost,
  unknownText = "Unknown",
  pendingText = "Pending",
}: {
  usage: TraceUsage;
  /** SDK-measured candidate case duration; null → Unknown, never 0. */
  durationMs: number | null;
  /** Authoritative candidate task cost (backend-denormalised); null → Unknown. */
  taskCost: number | null;
  /** The execution half's heading; a comparison names each run's own execution
   *  "Task execution", since a baseline isn't the candidate. */
  executionLabel?: string;
  /** How a known duration and cost read, so the summary can match the figures around it;
   *  an unknown one is "Unknown" either way. */
  formatDuration?: (ms: number) => string;
  formatCost?: (cost: number) => string;
  /** How a missing figure reads, so a caller can match the wording around it. */
  unknownText?: React.ReactNode;
  /** How a figure still on its way reads. */
  pendingText?: React.ReactNode;
}) {
  const pending = usage.state === "pending";
  const hasJudge = usage.scorer.spanCount > 0;

  return (
    <div className="w-full rounded-[2px] border border-border bg-background px-2.5 py-2 text-[12px]">
      <div className="grid grid-cols-1 gap-x-6 gap-y-2 sm:grid-cols-2">
        {/* Candidate execution — the thing under test. */}
        <div>
          <div className="mb-1 text-[12px] font-medium text-muted-foreground">{executionLabel}</div>
          <Row
            label="Duration"
            value={durationMs === null ? unknownText : formatDuration(durationMs)}
          />
          <Row label="Tokens" value={tokenText(usage, "task", unknownText, pendingText)} />
          <Row label="Task cost" value={taskCost === null ? unknownText : formatCost(taskCost)} />
          <Row label="Observed task model" value={modelText(usage, "task", pendingText)} mono />
        </div>

        {/* Evaluation overhead — the judge's cost of grading, kept apart so it never
            colours the candidate's own cost. */}
        <div>
          <div className="mb-1 text-[12px] font-medium text-muted-foreground">
            Evaluation overhead
          </div>
          {pending ? (
            <div className="text-muted-foreground">{pendingText}</div>
          ) : hasJudge ? (
            <>
              <Row label="Judge model" value={modelText(usage, "scorer", pendingText)} mono />
              <Row label="Judge tokens" value={usage.scorer.totalTokens.toLocaleString("en-US")} />
              <Row
                label="Judge cost"
                value={bucketCost(usage, "scorer", formatCost, unknownText, pendingText)}
              />
            </>
          ) : (
            <div className="text-muted-foreground">
              {usage.state === "unknown" ? unknownText : "No evaluator LLM calls"}
            </div>
          )}
        </div>
      </div>

      {/* The ONLY place a combined figure appears, and it is labelled as such so it is
          never mistaken for the candidate's own cost. Tokens only (one source). */}
      {!pending && hasJudge && (
        <div className="mt-2 border-t border-border pt-1.5 text-muted-foreground">
          Total including evaluation:{" "}
          <span className="font-medium text-foreground">
            {usage.combined.totalTokens.toLocaleString("en-US")}
          </span>{" "}
          tokens
        </div>
      )}
    </div>
  );
}

function Row({ label, value, mono }: { label: string; value: React.ReactNode; mono?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-0.5">
      <span className="text-muted-foreground">{label}</span>
      <span className={mono ? "font-mono" : "tabular-nums"}>{value}</span>
    </div>
  );
}

function defaultDuration(ms: number): string {
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
}

function defaultCost(c: number): string {
  return `$${c.toFixed(c < 0.01 ? 4 : 2)}`;
}

/** Token count for a bucket, honouring pending/unknown (never a coerced zero). */
function tokenText(
  u: TraceUsage,
  bucket: "task" | "scorer",
  unknownText: React.ReactNode,
  pendingText: React.ReactNode,
): React.ReactNode {
  if (u.state === "pending") return pendingText;
  if (u.state === "unknown") return unknownText;
  const b = u[bucket];
  return `${b.totalTokens.toLocaleString("en-US")} total · ${b.inputTokens.toLocaleString(
    "en-US",
  )} in · ${b.outputTokens.toLocaleString("en-US")} out`;
}

/** A bucket's cost, distinguishing an unattributed cost (Unknown) from a real zero. */
function bucketCost(
  u: TraceUsage,
  bucket: "task" | "scorer",
  formatCost: (cost: number) => string,
  unknownText: React.ReactNode,
  pendingText: React.ReactNode,
): React.ReactNode {
  if (u.state === "pending") return pendingText;
  const b = u[bucket];
  if (!b.costKnown) return unknownText;
  return formatCost(b.cost);
}

function modelText(
  u: TraceUsage,
  bucket: "task" | "scorer",
  pendingText: React.ReactNode,
): React.ReactNode {
  if (u.state === "pending") return pendingText;
  const models = u[bucket].models;
  return models.length > 0 ? models.join(", ") : "—";
}
