"use client";

import * as React from "react";
import { Loader2 } from "lucide-react";
import { DOMAIN_ICONS } from "@/components/icons/domain-icons";
import { DiffBox } from "@/features/traces/components/DiffBox";
import { attributeTraceUsage, type TraceUsage } from "@/lib/eval/trace-usage";
import type { TraceDetail } from "@/types/api";
import { ResultUsageSummary } from "../../components/result-usage-summary";
import type { ResultRow } from "../../types";
import { Delta, Dot } from "../cells";
import { formatCost, formatMs, signedWith } from "../metric-format";

/** One side of the pair with what its trace says it used. */
export interface UsageSide {
  heading: string;
  dot: string;
  result: ResultRow | undefined;
  /** The result's trace, once it has loaded. */
  trace: TraceDetail | undefined;
  /** The result names a trace that is still loading. */
  traceLoading: boolean;
}

/** What a result's trace says it used. A result that reported no trace has unknown usage,
 *  not usage still on its way. */
function usageOf(side: Pick<UsageSide, "result" | "trace">): TraceUsage {
  const usage = attributeTraceUsage(side.trace?.spans);
  return side.result && !side.result.traceId ? { ...usage, state: "unknown" } : usage;
}

/** One side's figure: a number, null when unknown, or "loading" while its trace loads. */
type MeasureValue = number | null | "loading";

/** The task's own tokens (a judge's are evaluation overhead); unknown when no task span
 *  reported a token count, even if the judge's did. */
const taskTokens = (side: UsageSide): MeasureValue => {
  if (side.traceLoading) return "loading";
  const { task } = usageOf(side);
  return task.tokensKnown ? task.totalTokens : null;
};
const formatTokens = (n: number) => n.toLocaleString("en-US");

/** A figure on its way, read as "Loading". */
function Loading() {
  return (
    <span className="inline-flex">
      <Loader2 aria-hidden className="h-3 w-3 animate-spin self-center text-muted-foreground" />
      <span className="sr-only">Loading</span>
    </span>
  );
}

/** "Latency: 1.0s → 1.2s +200ms", as a chip of the trace panel's: both sides and the change,
 *  "—" for a side that is unknown and a spinner for one still loading; said once when both
 *  sides are. */
function Measure({
  name,
  icon: Icon,
  baseline,
  candidate,
  fmt,
}: {
  name: string;
  icon: typeof DOMAIN_ICONS.latency;
  baseline: MeasureValue;
  candidate: MeasureValue;
  fmt: (n: number) => string;
}) {
  const delta =
    typeof baseline === "number" && typeof candidate === "number" ? candidate - baseline : null;
  const shown = (v: MeasureValue) => (v === "loading" ? <Loading /> : v === null ? "—" : fmt(v));
  return (
    <div
      data-metric={name}
      className="inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs"
    >
      <Icon aria-hidden className="h-3 w-3 text-muted-foreground" />
      <dt className="text-muted-foreground">{name}:</dt>
      <dd className="font-medium tabular-nums">
        {baseline === candidate && typeof baseline !== "number" ? (
          shown(baseline)
        ) : (
          <>
            {shown(baseline)} → {shown(candidate)}
          </>
        )}
        {delta !== null && (
          <Delta value={delta} text={signedWith(fmt)(delta)} direction="lower_is_better" />
        )}
      </dd>
    </div>
  );
}

/** The pair's latency, cost and tokens for the case, baseline → candidate, as the case's
 *  chips. Latency and cost are what each result recorded; tokens come from its trace. */
export function PairMeasures({
  baseline,
  candidate,
}: {
  baseline: UsageSide;
  candidate: UsageSide;
}) {
  return (
    // `contents`, so each chip sits in the chips row it is placed in.
    <dl role="group" aria-label="Usage for this case" className="contents">
      <Measure
        name="Latency"
        icon={DOMAIN_ICONS.latency}
        baseline={baseline.result?.durationMs ?? null}
        candidate={candidate.result?.durationMs ?? null}
        fmt={formatMs}
      />
      <Measure
        name="Cost"
        icon={DOMAIN_ICONS.cost}
        baseline={baseline.result?.cost ?? null}
        candidate={candidate.result?.cost ?? null}
        fmt={formatCost}
      />
      <Measure
        name="Tokens"
        icon={DOMAIN_ICONS.tokens}
        baseline={taskTokens(baseline)}
        candidate={taskTokens(candidate)}
        fmt={formatTokens}
      />
    </dl>
  );
}

/** Each side's usage, split into the run's own task execution and the evaluation's; folded
 *  away at first, since the case's chips already compare the totals. */
export function UsageDetails({ sides }: { sides: UsageSide[] }) {
  return (
    <DiffBox title="Usage breakdown" defaultOpen={false}>
      <div className="space-y-3">
        {sides.map((side) => (
          <div key={side.heading} className="space-y-1">
            <p className="flex items-center gap-1.5 font-medium">
              <Dot color={side.dot} />
              {side.heading}
            </p>
            {side.result ? (
              <ResultUsageSummary
                usage={usageOf(side)}
                durationMs={side.result.durationMs}
                taskCost={side.result.cost}
                executionLabel="Task execution"
                formatDuration={formatMs}
                formatCost={formatCost}
                unknownText="—"
                pendingText={<Loading />}
              />
            ) : (
              <p className="text-muted-foreground">No result in this run</p>
            )}
          </div>
        ))}
      </div>
    </DiffBox>
  );
}
