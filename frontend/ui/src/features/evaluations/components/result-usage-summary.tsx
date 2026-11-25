"use client";

import * as React from "react";
import type { TraceUsage } from "@/lib/eval/trace-usage";
import { useT } from "@/lib/i18n/provider";
import { Slots } from "@/lib/i18n/slots";
import type { Translate } from "@/lib/i18n/translate";

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
}: {
  usage: TraceUsage;
  /** SDK-measured candidate case duration; null → Unknown, never 0. */
  durationMs: number | null;
  /** Authoritative candidate task cost (backend-denormalised); null → Unknown. */
  taskCost: number | null;
}) {
  const t = useT();
  const pending = usage.state === "pending";
  const hasJudge = usage.scorer.spanCount > 0;

  return (
    <div className="w-full rounded-[2px] border border-border bg-background px-2.5 py-2 text-[12px] hover:bg-muted">
      <div className="grid grid-cols-1 gap-x-6 gap-y-2 sm:grid-cols-2">
        {/* Candidate execution — the thing under test. */}
        <div>
          <div className="mb-1 text-[12px] font-medium text-muted-foreground">
            {t("evalsUsage.candidateExecution")}
          </div>
          <Row label={t("evalsShared.duration")} value={fmtDuration(durationMs, t)} />
          <Row label="Tokens" value={tokenText(usage, "task", t)} />
          <Row label={t("evalsUsage.taskCost")} value={fmtCost(taskCost, t)} />
          <Row label={t("evalsUsage.observedTaskModel")} value={modelText(usage, "task", t)} mono />
        </div>

        {/* Evaluation overhead — the judge's cost of grading, kept apart so it never
            colours the candidate's own cost. */}
        <div>
          <div className="mb-1 text-[12px] font-medium text-muted-foreground">
            {t("evalsUsage.evaluationOverhead")}
          </div>
          {pending ? (
            <div className="text-muted-foreground">{t("evalsUsage.pending")}</div>
          ) : hasJudge ? (
            <>
              <Row label={t("evalsUsage.judgeModel")} value={modelText(usage, "scorer", t)} mono />
              <Row
                label={t("evalsUsage.judgeTokens")}
                value={usage.scorer.totalTokens.toLocaleString("en-US")}
              />
              <Row label={t("evalsUsage.judgeCost")} value={bucketCost(usage, "scorer", t)} />
            </>
          ) : (
            <div className="text-muted-foreground">
              {usage.state === "unknown" ? t("evalsRun.unknown") : t("evalsUsage.noEvaluatorCalls")}
            </div>
          )}
        </div>
      </div>

      {/* The ONLY place a combined figure appears, and it is labelled as such so it is
          never mistaken for the candidate's own cost. Tokens only (one source). */}
      {!pending && hasJudge && (
        <div className="mt-2 border-t border-border pt-1.5 text-muted-foreground">
          <Slots
            text={t("evalsUsage.totalIncluding")}
            slots={{
              count: (
                <span className="font-medium text-foreground">
                  {usage.combined.totalTokens.toLocaleString("en-US")}
                </span>
              ),
            }}
          />
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

function fmtDuration(ms: number | null, t: Translate): string {
  if (ms === null) return t("evalsRun.unknown");
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
}

function fmtCost(c: number | null, t: Translate): string {
  if (c === null) return t("evalsRun.unknown");
  return `$${c.toFixed(c < 0.01 ? 4 : 2)}`;
}

/** Token count for a bucket, honouring pending/unknown (never a coerced zero). */
function tokenText(u: TraceUsage, bucket: "task" | "scorer", t: Translate): string {
  if (u.state === "pending") return t("evalsUsage.pending");
  if (u.state === "unknown") return t("evalsRun.unknown");
  const b = u[bucket];
  return t("evalsUsage.tokenBreakdown", {
    total: b.totalTokens.toLocaleString("en-US"),
    input: b.inputTokens.toLocaleString("en-US"),
    output: b.outputTokens.toLocaleString("en-US"),
  });
}

/** A bucket's cost, distinguishing an unattributed cost (Unknown) from a real zero. */
function bucketCost(u: TraceUsage, bucket: "task" | "scorer", t: Translate): string {
  if (u.state === "pending") return t("evalsUsage.pending");
  const b = u[bucket];
  if (!b.costKnown) return t("evalsRun.unknown");
  return fmtCost(b.cost, t);
}

function modelText(u: TraceUsage, bucket: "task" | "scorer", t: Translate): string {
  if (u.state === "pending") return t("evalsUsage.pending");
  const models = u[bucket].models;
  return models.length > 0 ? models.join(", ") : "—";
}
