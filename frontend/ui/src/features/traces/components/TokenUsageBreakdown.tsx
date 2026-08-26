import { formatExactTokens } from "@/lib/utils";
import { MetricDelta } from "./MetricDelta";

export interface TokenCounts {
  inputTokens: number | null | undefined;
  outputTokens: number | null | undefined;
  totalTokens: number | null | undefined;
  cacheReadTokens?: number | null;
  cacheWriteTokens?: number | null;
  reasoningTokens?: number | null;
}

interface TokenUsageBreakdownProps extends TokenCounts {
  /** Baseline counts (trace diff mode) — renders a ± delta beside each row. */
  baseline?: TokenCounts;
}

/** Disjoint remainders so each section's rows sum to its total. */
function derive(t: TokenCounts) {
  const input = t.inputTokens ?? 0;
  const output = t.outputTokens ?? 0;
  const cacheRead = t.cacheReadTokens ?? 0;
  const cacheWrite = t.cacheWriteTokens ?? 0;
  const reasoning = t.reasoningTokens ?? 0;
  return {
    input,
    output,
    total: t.totalTokens ?? input + output,
    cacheRead,
    cacheWrite,
    reasoning,
    uncachedInput: Math.max(input - cacheRead - cacheWrite, 0),
    plainOutput: Math.max(output - reasoning, 0),
  };
}

type Derived = ReturnType<typeof derive>;

function Row({
  label,
  value,
  baseline,
  emphasis,
}: {
  label: string;
  value: number;
  baseline?: number;
  emphasis?: "section" | "total";
}) {
  return (
    <div
      className={
        emphasis === "total"
          ? "mt-2 flex justify-between gap-8 border-t border-border/60 pt-1 font-semibold"
          : emphasis === "section"
            ? "flex justify-between gap-8 border-b border-border/60 pb-1 font-medium"
            : "flex justify-between gap-8 text-muted-foreground"
      }
    >
      <span>{label}</span>
      <span className="tabular-nums">
        {formatExactTokens(value)}
        {baseline !== undefined && value !== baseline && (
          <MetricDelta delta={value - baseline} format={formatExactTokens} />
        )}
      </span>
    </div>
  );
}

/**
 * Hierarchical "Usage breakdown" panel for a span's token counts (issue #958).
 *
 * Input usage (gross input_tokens) splits into uncached input and its cache
 * components (same row order as CostBreakdown); output usage splits into reasoning and plain
 * output. The cache sub-rows always render — even at zero — so it's clear we
 * track cache tokens; reasoning renders only when non-zero (it's specific to
 * reasoning models). The uncached `input`/`output` leaf rows always render so
 * the section totals reconcile. Values are shown exactly (comma-grouped), not
 * compactly — this is the precise breakdown behind the compact `x → y (z)` chip.
 *
 * In trace diff mode a `baseline` is supplied and each row gains a ± delta.
 */
export function TokenUsageBreakdown(props: TokenUsageBreakdownProps) {
  const d = derive(props);
  const b: Derived | undefined = props.baseline ? derive(props.baseline) : undefined;

  return (
    <div className="min-w-[220px] text-xs">
      <div className="mb-2 font-semibold">Usage breakdown</div>

      <Row label="Input usage" value={d.input} baseline={b?.input} emphasis="section" />
      <div className="mt-1 space-y-0.5">
        {/* Always shown (even at zero) so it's clear cache tokens are tracked.
            Same row order as CostBreakdown so the two panels read in parallel. */}
        <Row label="uncached" value={d.uncachedInput} baseline={b?.uncachedInput} />
        <Row label="cache read" value={d.cacheRead} baseline={b?.cacheRead} />
        <Row label="cache write" value={d.cacheWrite} baseline={b?.cacheWrite} />
      </div>

      <div className="mt-2">
        <Row label="Output usage" value={d.output} baseline={b?.output} emphasis="section" />
      </div>
      <div className="mt-1 space-y-0.5">
        {(d.reasoning > 0 || (b?.reasoning ?? 0) > 0) && (
          <Row label="reasoning" value={d.reasoning} baseline={b?.reasoning} />
        )}
        <Row label="output" value={d.plainOutput} baseline={b?.plainOutput} />
      </div>

      <Row label="Total usage" value={d.total} baseline={b?.total} emphasis="total" />
    </div>
  );
}
